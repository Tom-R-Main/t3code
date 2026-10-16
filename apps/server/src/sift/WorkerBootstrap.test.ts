import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ThreadId } from "@t3tools/contracts";
import { WorkerBootstrapMaterialization } from "../../../../packages/contracts/src/workerBootstrap.ts";
import { prepareWorkerBootstrap } from "./WorkerBootstrap.ts";
import {
  fixtureBootstrapDigest,
  workerBootstrapFixture,
} from "../provider/testUtils/workerBootstrapFixture.ts";

it.effect(
  "binds the one-shot in-memory capability to exact runtime paths, model and instance",
  () =>
    Effect.gen(function* () {
      const fixture = workerBootstrapFixture();
      const prepared = yield* prepareWorkerBootstrap(
        fixture.materialization,
        fixture.target,
        fixture.environment,
      );
      const target = {
        ...fixture.target,
        binaryPath: "/opt/sift/codex",
        homePath: undefined,
        environment: fixture.environment,
        launchArgs: undefined,
        appServerArgs: undefined,
        hasResumeCursor: false,
      };
      for (const changed of [
        { ...target, threadId: ThreadId.make("other") },
        { ...target, cwd: "/other" },
        { ...target, model: "other" },
        { ...target, binaryPath: "/other" },
        { ...target, homePath: "/other" },
        { ...target, launchArgs: '-c model="other"' },
        { ...target, appServerArgs: ["--config=other"] },
        { ...target, hasResumeCursor: true },
        { ...target, environment: { ...fixture.environment, CODEX_WORKER_POLICY_V1: "{}" } },
      ])
        expect((yield* Effect.flip(prepared.capability.consume(changed)))._tag).toBe(
          "WorkerBootstrapError",
        );
      const bytes = yield* prepared.capability.consume(target);
      const payload = yield* Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({
            version: Schema.Literal(1),
            materialization: WorkerBootstrapMaterialization,
          }),
        ),
      )(new TextDecoder().decode(bytes));
      expect(payload.version).toBe(1);
      expect(fixtureBootstrapDigest(payload.materialization)).toBe(
        fixtureBootstrapDigest(fixture.materialization),
      );
      expect((yield* Effect.flip(prepared.capability.consume(target)))._tag).toBe(
        "WorkerBootstrapError",
      );
      bytes.fill(0);
      prepared.dispose();
    }),
);

it.effect(
  "refuses altered request hashes, authority, typed domains and lossy Unicode with generic errors",
  () =>
    Effect.gen(function* () {
      const fixture = workerBootstrapFixture();
      const original = fixture.materialization;
      const changedBody = { ...original, input: { ...original.input, launchId: "other" } };
      const { requestSha256: _requestSha256, ...body } = changedBody;
      const withFreshRequestHash = (value: typeof original) => {
        const { requestSha256: _previous, ...freshBody } = value;
        return { ...freshBody, requestSha256: fixtureBootstrapDigest(freshBody) };
      };
      const changes = [
        { ...original, requestSha256: "0".repeat(64) },
        { ...changedBody, requestSha256: fixtureBootstrapDigest(body) },
        withFreshRequestHash({
          ...original,
          runtime: { ...original.runtime, cwd: "/workspace/../other" },
        }),
        { ...original, input: { ...original.input, baseConfiguration: "\ud800" } },
        withFreshRequestHash({
          ...original,
          projection: { ...original.projection, registrySha256: "0".repeat(64) },
        }),
        withFreshRequestHash({
          ...original,
          template: { ...original.template, template: "# " + "x".repeat(262_144) },
        }),
      ];
      for (const changed of changes) {
        const error = yield* Effect.flip(
          prepareWorkerBootstrap(changed, fixture.target, fixture.environment),
        );
        expect(error.message).toBe("Restricted worker bootstrap unavailable.");
        expect("cause" in error).toBe(false);
      }
    }),
);
