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

## Keeping the fork current

Fork changes stay in `apps/server/src/sift/`, `apps/server/integration/siftBridge*`,
`packages/contracts/src/siftBridge.ts`, its export in `packages/contracts/src/index.ts`,
the layer entry in `apps/server/src/server.ts`, and one harness hook. Merge
`origin/main` into the fork branch before each image build, then run:

```bash
vp run --filter t3 typecheck
vp run --filter @t3tools/contracts typecheck
(cd apps/server && vp test run src/sift integration/siftBridge.integration.test.ts)
```

A conflict-free merge is not enough: upstream API changes surface only in the
typecheck and tests.

For cross-repository synthetic tests, run
`node apps/server/integration/siftBridge.fixture.ts` with the public-key variable.
It prints a ready record containing its PID, private socket, and temporary checkout.
It runs the real engine/provider/checkpoint reactors with a scripted adapter and
does not load model credentials. Stop the captured process when finished; its
scoped temporary SQLite database and Git workspace are then removed.
