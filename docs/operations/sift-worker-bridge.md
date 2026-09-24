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

Fork changes stay in `apps/server/src/sift/`, `apps/server/integration/siftBridge*`,
`packages/contracts/src/siftBridge.ts`, its export in `packages/contracts/src/index.ts`,
the layer entry in `apps/server/src/server.ts`, and one harness hook. Managed
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
