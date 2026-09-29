# Sift managed worker bridge

This fork adds an opt-in host interface to an isolated T3 environment. Sift owns
assignment authorization, lease enforcement, cross-agent delivery, and result
verification. T3 owns the local provider session and its durable orchestration.
The MIT license and upstream copyright notice remain in `LICENSE`.

Start the pinned server bundle with `serve --base-dir <isolated-runtime-home>`.
Configure `T3_SIFT_BRIDGE_SOCKET=/home/workspace/.sift-t3.sock` and
`T3_SIFT_BRIDGE_PUBLIC_KEY` with the host's Ed25519 public key encoded as base64
SPKI DER. The socket's existing parent directory must be owned by the process
user with mode 0700. Bridge activation without a valid key fails closed. Normal
T3 startup is unchanged when the socket variable is absent.

The host keeps the private key outside the worker VM/container. It must validate
the active work identity, lease, TTL, and the specific action before signing.
Worker shell tools share the T3 UID, so filesystem permissions alone do not
authorize approval responses. Pin the public key through host-controlled
configuration and keep the fork executable outside the writable checkout.

Each connection carries one JSON line containing `request` (the
`SiftBridgeRequest` contract) and `authorization: { expiresAt, signature }`.
`expiresAt` is Unix milliseconds, strictly in the future and at most 60 seconds
ahead. The signature is base64url Ed25519 over UTF-8 JSON of
`{ request, expiresAt }`, recursively sorting object keys in JavaScript lexical
order while preserving array order. The request envelope is limited to 256 KiB;
responses are limited to 512 KiB. Invalid authorization never reaches the engine.
Authorization is checked again after waiting for activation or the bridge mutex
and immediately before dispatch. The initial bridge supports approval-required
provider sessions only.

A runtime binds to one work item and canonical checkout/model/mode configuration.
Rebinding to a higher lease generation requires `expectedPreviousGeneration` and
preserves the thread history. Old-generation requests are rejected. Rebinding
records a session-stop request before later bridge commands; its acceptance is
not confirmation that a remote provider stopped. The host remains responsible
for observing termination and forcibly stopping its runtime when necessary.

Command identities are durable across process restarts. Retrying a command with
the same payload returns the original engine receipt; changing its payload or
generation requires a new command identity. Responses say `accepted`, never
`completed`: consume the bounded event replay and checkpoint evidence to assess
execution. An oversized event fails without advancing the cursor.
Assistant `thread.message-sent` events carry text deltas while streaming. The
completion event normally contains empty text: preserve the accumulated message
body. Persist accumulation by message identity together with the replay cursor;
dropping streaming events loses the answer even when execution completed.

This bridge does not expose provisioning, publication, A2A, lease renewal, or
human acceptance operations. Native approval forwarding accepts only one-time
accept, decline, or cancel decisions. A provider approval is distinct from Sift
authorization and acceptance of the resulting work.

An `approve` with a new command identity is checked against T3's approval
projection before dispatch. If another client already answered the request, the
reply is `already_resolved` with the recorded decision and nothing reaches the
provider. A `null` decision means T3 closed the request without one, for example
because provider callbacks did not survive a restart; start a new turn instead.
An ID that does not belong to this assignment's thread fails with
`UNKNOWN_REQUEST`. A retry of the original command still replays its receipt. A
native T3 client answering in the moment between this check and dispatch can
still produce a second provider response, which T3 records as a stale failure.
`answer` has no such projection and is not deduplicated across clients.

## Managed access

Set `T3_SIFT_MANAGED_ACCESS=1` when the host provisions the environment for one
assignment. Without it, nothing below runs and T3 authentication is unchanged.
With it, T3 serves only clients holding a credential the host minted for the
current attempt; every other session, including administrative and CLI-issued
ones, is rejected at authentication and at each RPC.

`attach` (`role`, `ttlSeconds` up to 12 hours, optional `label`) returns a
one-time T3 pairing credential. Any client redeems it through the normal pairing
flow (`/pair?token=`, `/api/auth/browser-session`, or `/oauth/token`). The
credential expires after `min(ttlSeconds, 15 minutes)` if unused. The session it
creates carries a signed subject of the form
`sift-managed:v1:<role>:<attempt>:<deadline>`, where `<attempt>` is the SHA-256
of the runtime ID, work item ID, lease generation, and an access epoch. `attach` fails with
`MANAGED_ACCESS_DISABLED` when managed mode is off, because the same scopes
would otherwise apply to the whole environment.

The bridge records each credential it issues (a hash of the credential and its
subject) in `sift_managed_access_grants`. Redeeming a pairing credential whose
subject starts with `sift-managed:` binds the new session to that record, or
revokes the session if no unclaimed record matches. A managed subject is
therefore honoured only on the one session produced from a bridge `attach`;
sessions or pairing links that the auth CLI signs with a copied or edited
subject are rejected.

Each HTTP request and RPC checks that the session is bound to a bridge record
with the same subject, that the subject parses, that its deadline has
not passed, that its attempt is the ready binding, and, for RPCs, that the
session has not been revoked. `detach` revokes every managed pairing link and
session. It first advances the access epoch and clears the bridge records, so a link redeemed while revocation
is in progress yields a session for a superseded attempt that every check
rejects. A rebind to a new lease generation does the same before the generation
is marked ready. Revocation and the deadline also end open subscription streams.

Roles:

- `reviewer` (scopes `orchestration:read`, `review:write`): the shell, the bound
  thread's subscription and diffs, server config and lifecycle streams, review
  diff previews, and file listing, search, and reads inside the checkout. Paths
  must be relative, and reads resolve symlinks and must stay inside the
  checkout. Review diffs require `cwd` to be the checkout and the checkout to be
  its own Git top level, because the service reads the whole repository from
  its root; a checkout nested in a larger repository gets no review diffs. VCS
  status (`subscribeVcsStatus`, `vcsRefreshStatus`) is refused for both roles:
  refreshing it pulls the checkout when the project's auto-pull setting is on. Review refs must be plain branch names or
  hashes (no leading `-`, `..`, `@{`, or other revision syntax).
- `operator` (adds `orchestration:operate`): everything a reviewer has, plus
  `orchestration.dispatchCommand` for the bound thread only, limited to
  `thread.turn.start`, `thread.turn.interrupt`, `thread.approval.respond`,
  `thread.user-input.respond`, `thread.user-input.dismiss`, and
  `thread.session.stop`. A turn must keep the bound runtime mode and model and
  cannot carry attachments, a bootstrap (thread or worktree creation), or a plan
  from another thread.

Every other RPC is refused for both roles, including terminals, provider
install, update, and authentication, settings and keybindings, process signals,
project, thread, and worktree creation, file writes, filesystem browsing,
source control and pull request actions, previews, devices, and access
management. An RPC that upstream adds later is refused until it is listed. Over
HTTP a managed session may reach only `GET /api/auth/session`,
`POST /api/auth/websocket-ticket`, `GET /ws`, and
`GET /api/orchestration/threads/<bound thread>`.

Managed mode refuses to start, and a running server refuses managed requests
and `attach`, while the server environment sets `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`, `GIT_ALTERNATE_OBJECT_DIRECTORIES`,
`GIT_COMMON_DIR`, or `GIT_NAMESPACE`, or injects `core.worktree` or `core.bare`
through `GIT_CONFIG_PARAMETERS` or `GIT_CONFIG_KEY_<n>`. T3's git operations
inherit that environment, so they could otherwise read a repository other than
the checkout the policy validated.

Managed access trusts the SQLite state database. A process running as the T3
user can write that database or the server's signing secret directly and forge
any record; this is an accepted limit, and the host must keep worker tools from
running as that user if it needs a stronger boundary.

The environment is expected to hold only the bridge's project and thread. The
shell subscription is not filtered, so any other project or thread created
before managed mode was enabled remains visible in it. Attachment uploads and
images served over HTTP are unavailable to managed clients.

## Keeping the fork current

### Managed Codex interruption

With `T3_SIFT_MANAGED_ACCESS=1`, interrupting Codex also reconciles commands
owned by the interrupted provider turn. Native Codex interruption deliberately
preserves background terminals. The managed adapter uses the experimental
`thread/backgroundTerminals/list` and `terminate` APIs verified with Codex
0.157.1, matching provider thread, turn, command item, and process identities.
Earlier-turn terminals remain running. A child requires both provider-reported
parent lineage and the parent's explicit started-activity turn. Children from
older parent turns remain running; background commands from completed children
of the interrupted assignment are included. A child whose spawn is verified
but which has not yet started a turn is part of the interrupted assignment:
cleanup waits, within its bound, for that child to start (and then settles its
turn) or for its thread to close, and otherwise stays unconfirmed. Cleanup re-derives the owned set on every
pass, so a child whose assignment arrives after the interrupt began is
interrupted, awaited for its terminal receipt and reconciled within the same
bound; if the set is still changing at the bound, termination stays unconfirmed.
Late work is tracked per thread and turn, so a new assigned turn on a child
already in the snapshot is reconciled the same way. Once an interruption is
unconfirmed it stays unconfirmed for the session: a later interrupt only proves
its own turn's commands, so only Stop clears it. A child reporting back to its
parent or root transfers no ownership. Reassignment across parent turns
without an unambiguous ownership transition fails closed. Command text, checkout
paths, and host process names grant no cleanup authority. Ordinary unmanaged T3
retains native Codex behavior.

While reconciliation is pending, the adapter withholds the parent completion
event and refuses new turns. It waits for actual matching provider turn-completed
receipts (completed, interrupted or failed) before reconciling processes; an accepted interrupt alone never becomes
a synthesized completion. Turns whose preparation crossed an interrupt must be
submitted again. A turn whose `turn/start` response arrives after an interrupt
began is interrupted and refused, and the session stays unconfirmed until Stop.
A resumed managed session (any session started with a resume cursor, including
one that falls back to a fresh thread) is refused until two things hold. First,
the host has attested that the previous app-server's process tree is gone
(`T3_SIFT_PRIOR_PROCESS_TREE_TERMINATED`, below): Codex keeps background
terminals in the app-server's memory, so nothing in the provider protocol can
reveal processes the previous app-server left. Second, every thread loaded in the
new app-server (`thread/loaded/list`, then each thread's
`thread/backgroundTerminals/list`) reports no background terminals; Codex keeps
terminals per thread session, so the root alone is not enough. A missing or
malformed attestation, any reported terminal, an empty loaded set, or any listing
failure leaves the session unconfirmed until Stop. Missing ownership (including terminals inherited
after reconnect without observed item history), changed execution, protocol
errors, or bounded reconciliation exhaustion produce an explicit error stating
that termination is unconfirmed. They do not restart or kill the provider.
The user can explicitly stop the session; a successful managed interrupt keeps
the session available for another turn. Same-turn commands are not independently
registered retained services. Service ownership belongs in the workspace
service-grant integration.

Offline regression tests run the real runtime against a scripted provider that
owns disposable processes. They prove targeted cleanup and surviving sibling
and earlier-turn processes. Release acceptance still requires the lifecycle
probe against the exact rebuilt image with real Codex: offline protocol and
fixture results do not establish real-provider process termination.

#### Host contract: `T3_SIFT_PRIOR_PROCESS_TREE_TERMINATED`

- **Name**: `T3_SIFT_PRIOR_PROCESS_TREE_TERMINATED`, an environment variable of
  the T3 server process. Read only with `T3_SIFT_MANAGED_ACCESS=1`.
- **Value**: the decimal process-group id of the previous T3 server for the same
  runtime: `^[1-9][0-9]{0,9}$`, at most 2147483647. Any other value counts as
  absent.
- **Who sets it**: the Sift host daemon, never an operator or a client.
- **When**: only when the daemon launches a replacement T3 server for a runtime
  whose previous T3 server it launched, and only after it has confirmed that no
  process descended from that server remains: the previous Codex app-server and
  every command it started, including commands running in their own session or
  process group (for example under a PTY). An empty process group alone is not
  sufficient; track descendants by a containment the commands cannot leave, such
  as a cgroup or systemd scope. Omit the variable on a first launch and whenever
  that confirmation is not available.
- **Effect**: valid only for the first managed provider session this T3 server
  process starts, fresh or resumed. Any earlier managed session start in the
  process consumes it, so a resume after an in-process replacement is refused
  until the host restarts T3. The loaded-thread terminal check still runs. The
  value is an assertion by the host; T3 does not inspect the host's process
  table.

#### In-process replacement and close

Closing a managed provider session (Stop, or replacement by another session in
the same T3 server) first terminates every background terminal on every loaded
thread of its app-server, each with the provider's confirmation, and requires a
final empty listing. The next app-server cannot see terminals the closed one
leaves, so this is the only point where they can be proved gone. If that proof
fails (listing or termination errors, a refusal, or the bound is exhausted),
the T3 server process is tainted: every later managed session in it, fresh or
resumed, starts unconfirmed and refuses turns until the host restarts T3 (with
the attestation above, once the host has confirmed the tree is gone).
Managed session starts in one T3 server wait for every close-time proof still
in progress before starting, and every session reads the taint live, so a
session that was already running also refuses new turns once the taint is set.

#### Admission

Principle: any uncertainty about owned provider work closes managed admission
until Stop or a host restart of T3; only positive proof reopens it.

One predicate decides admission, read live each time: no interruption in
progress, no unconfirmed cleanup, no turn that crossed an interruption or whose
start outcome is uncertain, no observed conflict in command ownership history,
no close in progress, and no process taint. It gates every point that starts or
continues provider work or reports the session ready or running: before and
after `turn/start` (including after the turn is recorded), compaction, accepting
an approval, answering a question, the `turn/started` and `turn/completed`
status updates, rollback, the end of an interruption, and session start. A
closed check leaves the session in error. Closing admission is sticky and
cancels parked approvals. A root turn the provider starts while admission is
closed for any reason (including a queued follow-up Codex starts during an
interruption) is interrupted; an interruption confirms only after each such turn
has its terminal receipt and a confirmed cleanup of its own work. Closing
admission does not stop a turn already admitted and running; Stop does.

Approval decisions are classified by effect, not by name: anything other than
decline or cancel (accept, acceptForSession, acceptAlways, and any future
variant) lets work proceed. While admission is closed such a decision is refused
when submitted and, independently, replaced by cancel where each handler returns
its answer to Codex (command, file-change, permissions and MCP elicitation
approvals). Question answers are refused at both points as well.

Provider requests and their failure paths:

| Request                                                  | Creates or continues work         | Rejection, decode failure, timeout or abort                                                                                 |
| -------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `turn/start`                                             | Yes                               | Treated as possibly accepted: admission closes, and any root turn seen starting since the request is interrupted.           |
| approval accept (any accepting variant), question answer | Yes (continues a turn)            | Refused while admission is closed, at submission and where the answer reaches Codex; declining or cancelling stays allowed. |
| `thread/compact/start`                                   | Summarizes history; runs no tools | Refused while admission is closed. A failed compaction cannot leave commands, so it does not close admission.               |
| `thread/rollback`                                        | No                                | History only; failure leaves status unchanged.                                                                              |
| `thread/start`, `thread/resume`                          | Opens the session                 | Failure fails `start`; the session is never admitted and close still settles and sweeps.                                    |
| `turn/interrupt`                                         | No (reduces work)                 | Failure leaves cleanup unconfirmed, which closes admission.                                                                 |

Ownership history that the tracker cannot establish (a command item reported
under two turns or process ids, a bound exceeded) closes admission as soon as it
is observed.

Close is a proof in two steps: first every live turn (and any spawned child that
has not started or closed) is interrupted and its terminal receipt awaited, then
every loaded thread's background terminals are terminated with confirmation and
a final listing must be empty. Either step failing, or unknown ownership, taints
the process. The proof is taint-by-default: a close counts as unproven from the
moment Stop or replacement begins it until the runtime reports the completed
proof, so an interrupted Stop or replacement fiber leaves the process tainted.
An interrupted interruption leaves admission closed, and an interrupted
`turn/start` after it was sent closes admission.

Bridge changes stay in `apps/server/src/sift/`, `apps/server/integration/siftBridge*`,
`packages/contracts/src/siftBridge.ts`, its export in `packages/contracts/src/index.ts`,
the layer entry in `apps/server/src/server.ts`, and one harness hook. Managed
Codex interruption adds the scoped ownership helper and hooks in the Codex
adapter and session runtime under `apps/server/src/provider/`. Managed
access adds two hooks in upstream files: `makeHttpGate` in
`apps/server/src/auth/EnvironmentAuth.ts` (applied after token verification and
WebSocket ticket verification, and after session issuance in the two
pairing-credential redemption paths) and `withRpcGuard` around the handler object in
`apps/server/src/ws.ts`. The guard calls each handler before authorizing it and
relies on handlers building their effects lazily, as they do today. Merge
`origin/main` into the fork branch before each image build, then run:

```bash
vp run --filter t3 typecheck
vp run --filter @t3tools/contracts typecheck
(cd apps/server && vp test run src/auth src/sift integration/siftBridge.integration.test.ts)
```

A conflict-free merge is not enough: upstream API changes surface only in the
typecheck and tests.

For cross-repository synthetic tests, run
`node apps/server/integration/siftBridge.fixture.ts` with the public-key variable.
It prints a ready record containing its PID, private socket, and temporary checkout.
It runs the real engine/provider/checkpoint reactors with a scripted adapter and
does not load model credentials. Stop the captured process when finished; its
scoped temporary SQLite database and Git workspace are then removed.
