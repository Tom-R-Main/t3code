// @effect-diagnostics nodeBuiltinImport:off
import * as Assert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { makeCodexSessionRuntime } from "./CodexSessionRuntime.ts";

it.live("reads opaque native attestation on an already-loaded thread without a model turn", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const peer = path.join(import.meta.dirname, "../testUtils/codexWorkerPolicyPeer.ts");
    const scripted = ChildProcessSpawner.make(() => spawner.spawn(ChildProcess.make(process.execPath, [peer])));
    const launch = { version: 1, launchId: "launch", incarnationId: "incarnation", bindingSha256: "a".repeat(64),
      executorProtocolVersion: "sift-worker-executor-v1", server: "sift", namespace: "sift", tool: "execute",
      rawTool: "execute", endpoint: "http://127.0.0.1:4321/mcp", serverConfigSha256: "b".repeat(64),
      model: "fixture-model", modelProviderId: "fixture-provider", modelProviderSha256: "c".repeat(64) };
    const runtime = yield* makeCodexSessionRuntime({
      threadId: ThreadId.make("bound-thread"), binaryPath: process.execPath, cwd: process.cwd(),
      runtimeMode: "approval-required", environment: {
        CODEX_RESTRICTED_WORKER: "1", CODEX_WORKER_POLICY_V1: JSON.stringify(launch),
      },
    }).pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scripted));
    const read = runtime.readWorkerPolicy;
    Assert.ok(read);
    const beforeStart = yield* Effect.flip(read("fresh", true));
    Assert.equal(beforeStart._tag, "CodexApprovalDecisionError");
    yield* runtime.start();
    Assert.deepEqual(yield* read("fresh", true), { providerThreadId: "provider-thread", attestation: {
      coverageComplete: false, configSha256: null, challenge: "fresh", threadId: "provider-thread", prepare: true,
      methods: ["initialize", "initialized", "thread/start", "workerPolicy/read"],
    } });
    const mismatched = yield* read("mismatch", false);
    Assert.equal(mismatched.providerThreadId, "provider-thread", "Mapping must come from the loaded cursor, not attestation fields");
    Assert.equal(Schema.decodeUnknownSync(Schema.Struct({ threadId: Schema.String }))(mismatched.attestation).threadId, "untrusted-asserted-thread");
    Assert.equal((yield* Effect.flip(read("line\nbreak", true)))._tag, "CodexApprovalDecisionError");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
