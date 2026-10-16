// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import {
  makeCodexSessionRuntime,
  type CodexSessionRuntimeSendTurnInput,
} from "./CodexSessionRuntime.ts";
import { prepareWorkerBootstrap, WorkerBootstrap } from "../../sift/WorkerBootstrap.ts";
import { workerBootstrapFixture } from "../testUtils/workerBootstrapFixture.ts";

it.live("reads opaque native attestation on an already-loaded thread without a model turn", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const path = yield* Path.Path;
    const peer = path.join(import.meta.dirname, "../testUtils/codexWorkerPolicyPeer.ts");
    const scripted = ChildProcessSpawner.make((command) => {
      NodeAssert.equal(command._tag, "StandardCommand");
      if (command._tag !== "StandardCommand") throw new Error("Unexpected fixture pipeline");
      NodeAssert.deepEqual(command.options.additionalFds, { fd3: { type: "input" } });
      return spawner.spawn(ChildProcess.make(process.execPath, [peer], command.options));
    });
    const fixture = workerBootstrapFixture(process.cwd(), process.execPath);
    const bootstrap = yield* prepareWorkerBootstrap(
      fixture.materialization,
      fixture.target,
      fixture.environment,
    );
    yield* Effect.addFinalizer(() => Effect.sync(bootstrap.dispose));
    const runtime = yield* makeCodexSessionRuntime({
      ...fixture.target,
      binaryPath: process.execPath,
      runtimeMode: "approval-required",
      environment: fixture.environment,
    }).pipe(
      Effect.provideService(WorkerBootstrap, bootstrap.capability),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scripted),
    );
    const read = runtime.readWorkerPolicy;
    NodeAssert.ok(read);
    const beforeStart = yield* Effect.flip(read("fresh", true));
    NodeAssert.equal(beforeStart._tag, "CodexApprovalDecisionError");
    yield* runtime.start();
    NodeAssert.deepEqual(yield* read("fresh", true), {
      providerThreadId: "provider-thread",
      attestation: {
        coverageComplete: false,
        configSha256: null,
        challenge: "fresh",
        threadId: "provider-thread",
        prepare: true,
        methods: [
          "fd3-unix-stream-eof",
          "initialize",
          "initialized",
          "thread/start",
          "workerPolicy/read",
        ],
      },
    });
    const mismatched = yield* read("mismatch", false);
    NodeAssert.equal(
      mismatched.providerThreadId,
      "provider-thread",
      "Mapping must come from the loaded cursor, not attestation fields",
    );
    const mismatchedAttestation = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ threadId: Schema.String }),
    )(mismatched.attestation);
    NodeAssert.equal(mismatchedAttestation.threadId, "untrusted-asserted-thread");
    NodeAssert.equal(
      (yield* Effect.flip(read("line\nbreak", true)))._tag,
      "CodexApprovalDecisionError",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses a restricted runtime without trusted capability before spawning", () =>
  Effect.gen(function* () {
    const fixture = workerBootstrapFixture(process.cwd(), process.execPath);
    let spawns = 0;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const guarded = ChildProcessSpawner.make((command) => {
      spawns++;
      return spawner.spawn(command);
    });
    const error = yield* makeCodexSessionRuntime({
      ...fixture.target,
      binaryPath: process.execPath,
      runtimeMode: "approval-required",
      environment: fixture.environment,
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guarded), Effect.flip);
    NodeAssert.equal(error._tag, "CodexAppServerSpawnError");
    NodeAssert.equal(spawns, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "uses only sealed native startup defaults and text-only turn fields through the actual runtime transport",
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peer = path.join(import.meta.dirname, "../testUtils/codexWorkerPolicyPeer.ts");
      const scripted = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") throw new Error("Unexpected fixture pipeline");
        return spawner.spawn(ChildProcess.make(process.execPath, [peer], command.options));
      });
      const fixture = workerBootstrapFixture(process.cwd(), process.execPath);
      const prepared = yield* prepareWorkerBootstrap(
        fixture.materialization,
        fixture.target,
        fixture.environment,
      );
      yield* Effect.addFinalizer(() => Effect.sync(prepared.dispose));
      const runtime = yield* makeCodexSessionRuntime({
        ...fixture.target,
        binaryPath: process.execPath,
        runtimeMode: "approval-required",
        environment: fixture.environment,
      }).pipe(
        Effect.provideService(WorkerBootstrap, prepared.capability),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scripted),
      );
      yield* runtime.start();
      const refused: ReadonlyArray<CodexSessionRuntimeSendTurnInput> = [
        { input: "refused", model: "other-model" },
        { input: "refused", effort: "high" },
        { input: "refused", serviceTier: "fast" },
        { input: "refused", interactionMode: "plan" },
        {
          input: "refused",
          attachments: [{ type: "localImage", path: "/workspace/should-not-read.png" }],
        },
      ];
      for (const input of refused)
        NodeAssert.equal(
          (yield* Effect.flip(runtime.sendTurn(input)))._tag,
          "CodexAppServerRequestError",
        );
      const text = 'Exact fixture text: "quoted"\n$skill stays literal.';
      const turn = yield* runtime.sendTurn({
        input: text,
        model: fixture.target.model,
        interactionMode: "default",
      });
      NodeAssert.equal(turn.turnId, "sealed-turn");
      const read = runtime.readWorkerPolicy;
      NodeAssert.ok(read);
      const result = yield* read("after-turn", false);
      const observed = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          methods: Schema.Array(Schema.String),
          threadStart: Schema.Unknown,
          turnStart: Schema.Unknown,
        }),
      )(result.attestation);
      NodeAssert.deepEqual(observed.threadStart, {});
      NodeAssert.deepEqual(observed.turnStart, {
        threadId: "provider-thread",
        input: [{ type: "text", text }],
      });
      NodeAssert.equal(observed.methods.filter((method) => method === "turn/start").length, 1);
      NodeAssert.equal(observed.methods.includes("thread/resume"), false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("refuses cold resume and mutable service tiers before any restricted child spawn", () =>
  Effect.gen(function* () {
    const fixture = workerBootstrapFixture(process.cwd(), process.execPath);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    let spawns = 0;
    const guarded = ChildProcessSpawner.make((command) => {
      spawns++;
      return spawner.spawn(command);
    });
    for (const changed of [
      { resumeCursor: { threadId: "previous-provider-thread" } },
      { serviceTier: "fast" },
    ]) {
      const prepared = yield* prepareWorkerBootstrap(
        fixture.materialization,
        fixture.target,
        fixture.environment,
      );
      yield* Effect.addFinalizer(() => Effect.sync(prepared.dispose));
      const error = yield* makeCodexSessionRuntime({
        ...fixture.target,
        ...changed,
        binaryPath: process.execPath,
        runtimeMode: "approval-required",
        environment: fixture.environment,
      }).pipe(
        Effect.provideService(WorkerBootstrap, prepared.capability),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, guarded),
        Effect.flip,
      );
      NodeAssert.equal(error._tag, "CodexAppServerSpawnError");
    }
    NodeAssert.equal(spawns, 0);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "sanitizes a failed FD callback, zeroes transferred bytes and reaps the captured child before initialization",
  () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peer = path.join(import.meta.dirname, "../testUtils/codexWorkerPolicyPeer.ts");
      const fixture = workerBootstrapFixture(process.cwd(), process.execPath);
      const prepared = yield* prepareWorkerBootstrap(
        fixture.materialization,
        fixture.target,
        fixture.environment,
      );
      yield* Effect.addFinalizer(() => Effect.sync(prepared.dispose));
      let captured: ChildProcessSpawner.ChildProcessHandle | undefined;
      let offered: Uint8Array | undefined;
      let initialized = false;
      const scripted = ChildProcessSpawner.make((command) => {
        if (command._tag !== "StandardCommand") throw new Error("Unexpected fixture pipeline");
        return spawner.spawn(ChildProcess.make(process.execPath, [peer], command.options)).pipe(
          Effect.map((child) => {
            captured = child;
            return {
              ...child,
              stdin: Sink.fromEffect(
                Effect.sync(() => {
                  initialized = true;
                }),
              ),
              getInputFd: () => Sink.fromEffect(Effect.die(new Error("PRIVATE-FIXTURE-CALLBACK"))),
            };
          }),
        );
      });
      const error = yield* makeCodexSessionRuntime({
        ...fixture.target,
        binaryPath: process.execPath,
        runtimeMode: "approval-required",
        environment: fixture.environment,
      }).pipe(
        Effect.provideService(WorkerBootstrap, {
          ...prepared.capability,
          consume: (target) =>
            prepared.capability.consume(target).pipe(
              Effect.tap((bytes) =>
                Effect.sync(() => {
                  offered = bytes;
                }),
              ),
            ),
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scripted),
        Effect.flip,
      );
      NodeAssert.equal(error._tag, "CodexAppServerSpawnError");
      NodeAssert.ok(!error.message.includes("PRIVATE-FIXTURE-CALLBACK"));
      NodeAssert.equal(initialized, false);
      NodeAssert.ok(captured);
      NodeAssert.equal(yield* captured.isRunning, false);
      NodeAssert.ok(offered && offered.byteLength > 0 && offered.every((byte) => byte === 0));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
