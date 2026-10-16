import * as NodeAssert from "node:assert/strict";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const output = process.env.SIFT_QUALIFICATION_OUTPUT;
NodeAssert.ok(
  output && process.env.GITHUB_ACTIONS === "true",
  "Run only in the isolated qualification job",
);
const branches = ["codex/uix-c3a-exact-decisions", "codex/uix-c4-executor-bridge"];
NodeAssert.ok(branches.includes(process.env.GITHUB_REF_NAME), "Unsupported qualification branch");
NodeFS.mkdirSync(output, { recursive: true });
const summary = {
  version: 1,
  head: process.env.GITHUB_SHA,
  branch: process.env.GITHUB_REF_NAME,
  scope: "model-free T3 contracts, native protocol extension and approval effect fixtures",
  status: "incomplete",
  toolchain: {},
  lanes: [],
  typechecks: [],
};
const record = () =>
  NodeFS.writeFileSync(NodePath.join(output, "summary.json"), JSON.stringify(summary, null, 2));
const hash = (path) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
function run(command, args, cwd, label, timeout = 300_000) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  NodeFS.writeFileSync(NodePath.join(output, `${label}.log`), log);
  process.stdout.write(log);
  return { result, log };
}
function checked(command, args, cwd, label) {
  const { result, log } = run(command, args, cwd, label);
  NodeAssert.ok(
    !result.error && result.status === 0 && result.signal === null,
    `${label} failed or timed out`,
  );
  return log;
}
try {
  record();
  const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(root, "package.json"), "utf8"));
  NodeAssert.equal(pkg.packageManager, "pnpm@11.10.0");
  NodeAssert.equal(process.version, "v24.13.1");
  const vitePackage = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, "node_modules/vite-plus/package.json"), "utf8"),
  );
  const tsPackage = JSON.parse(
    NodeFS.readFileSync(NodePath.join(root, "node_modules/typescript/package.json"), "utf8"),
  );
  NodeAssert.equal(vitePackage.version, "0.3.3");
  NodeAssert.equal(tsPackage.version, "7.0.2");
  summary.toolchain = {
    node: process.version,
    packageManager: pkg.packageManager,
    vitePlus: vitePackage.version,
    typescript: tsPackage.version,
    lockSha256: hash(NodePath.join(root, "pnpm-lock.yaml")),
  };
  NodeAssert.equal(
    checked("git", ["rev-parse", "HEAD"], root, "checked-head").trim(),
    summary.head,
  );
  checked(
    "git",
    [
      "diff",
      "--exit-code",
      "HEAD",
      "--",
      "apps/server",
      "packages/contracts",
      "packages/effect-codex-app-server",
    ],
    root,
    "source-clean",
  );
  checked("vp", ["--version"], root, "vp-version");
  const help = checked("vp", ["test", "--help"], root, "vp-test-help");
  for (const flag of ["reporter", "outputFile", "maxWorkers", "fileParallelism"])
    NodeAssert.ok(
      help.replace(/[-_]/g, "").toLowerCase().includes(flag.toLowerCase()),
      `Installed test CLI does not advertise ${flag}`,
    );
  const lanes = [
    {
      name: "codex-wire",
      cwd: "packages/effect-codex-app-server",
      files: ["src/commandApprovalExtensions.test.ts", "src/client.test.ts"],
    },
    { name: "contracts", cwd: "packages/contracts", files: ["src/siftBridge.test.ts"] },
    {
      name: "server",
      cwd: "apps/server",
      files: [
        "src/provider/Layers/CodexApprovalDecision.test.ts",
        "src/provider/Layers/CodexApprovalDecision.peer.test.ts",
        "src/sift/ApprovalEffects.test.ts",
        "src/sift/Bridge.test.ts",
        "src/orchestration/Layers/ProviderRuntimeIngestion.approval.test.ts",
        "integration/siftBridge.approvalEffects.integration.test.ts",
        ...(process.env.GITHUB_REF_NAME === branches[1]
          ? [
              "src/sift/WorkerPolicy.test.ts",
              "src/sift/Socket.test.ts",
              "src/provider/ProviderInstanceEnvironment.test.ts",
              "src/provider/Layers/CodexWorkerPolicy.peer.test.ts",
            ]
          : []),
      ],
    },
  ];
  // These existing model-free regression suites construct the driver/reactor
  // layers whose required durable SQL context changed with approval effects.
  // Keep their runtime counts separate from the original focused 40-test lane.
  lanes.push({
    name: "server-regressions",
    cwd: "apps/server",
    typecheck: false,
    files: [
      "src/provider/Layers/ProviderRegistry.test.ts",
      "src/project/AgentSessionImporter.test.ts",
    ],
  });
  let failed = false;
  for (const lane of lanes) {
    const cwd = NodePath.join(root, lane.cwd),
      reportPath = NodePath.join(output, `${lane.name}.json`);
    const item = {
      name: lane.name,
      package: lane.cwd,
      expectedFiles: lane.files,
      status: "failed",
      passed: 0,
      total: 0,
    };
    summary.lanes.push(item);
    record();
    try {
      NodeAssert.ok(!NodeFS.existsSync(reportPath), "Fresh test report path required");
      for (const file of lane.files)
        NodeAssert.ok(
          NodeFS.existsSync(NodePath.join(cwd, file)),
          `Required test missing: ${file}`,
        );
      const { result } = run(
        "vp",
        [
          "test",
          "run",
          ...lane.files,
          "--maxWorkers=1",
          "--no-file-parallelism",
          "--reporter=default",
          "--reporter=json",
          `--outputFile=${reportPath}`,
        ],
        cwd,
        lane.name,
        600_000,
      );
      const report = JSON.parse(NodeFS.readFileSync(reportPath, "utf8"));
      item.total = report.numTotalTests;
      item.passed = report.numPassedTests;
      NodeAssert.ok(
        !result.error && result.status === 0 && result.signal === null,
        "Test process failed or timed out",
      );
      NodeAssert.equal(report.success, true);
      NodeAssert.ok(
        Number.isSafeInteger(item.total) && item.total > 0 && item.passed === item.total,
        "No positive complete test count",
      );
      for (const key of [
        "numFailedTests",
        "numFailedTestSuites",
        "numPendingTests",
        "numPendingTestSuites",
        "numTodoTests",
      ])
        NodeAssert.equal(report[key], 0, `Nonpassing count: ${key}`);
      NodeAssert.deepEqual(
        report.testResults.map((file) => NodePath.resolve(file.name)).sort(),
        lane.files.map((file) => NodePath.join(cwd, file)).sort(),
      );
      let actualCount = 0;
      for (const file of report.testResults) {
        NodeAssert.equal(file.status, "passed");
        NodeAssert.ok(file.assertionResults.length > 0, `No tests executed: ${file.name}`);
        for (const test of file.assertionResults)
          NodeAssert.equal(test.status, "passed", `Test did not pass: ${test.fullName}`);
        actualCount += file.assertionResults.length;
      }
      NodeAssert.equal(actualCount, item.total);
      item.status = "passed";
    } catch (error) {
      item.error = String(error);
      failed = true;
    }
    record();
    // A timed-out runner may have uncertain child cleanup. Start no later lane
    // after any failure; the hosted job retains evidence and tears down.
    NodeAssert.ok(!failed, "Test lane failed; remaining qualification was not run");
  }
  // Package scripts resolve the pinned compiler; one scoped invocation at a time.
  // Regression suites share the server package and must not duplicate its check.
  for (const lane of lanes.filter((lane) => lane.typecheck !== false)) {
    const item = { package: lane.cwd, status: "failed" };
    summary.typechecks.push(item);
    record();
    const { result } = run(
      NodePath.join(root, "node_modules/.bin/tsc"),
      ["--noEmit"],
      NodePath.join(root, lane.cwd),
      `${lane.name}-typecheck`,
    );
    item.exitCode = result.status;
    if (
      result.error ||
      result.signal !== null ||
      !Number.isInteger(result.status) ||
      result.status < 0
    ) {
      // Spawn failure, timeout and signal termination leave cleanup uncertain.
      // Never start another compiler after an abnormal process outcome.
      item.processOutcome = "abnormal_exit";
      item.error = String(result.error ?? result.signal ?? "Unknown compiler process outcome");
      record();
      throw new Error(
        "Compiler process did not exit normally; remaining qualification was not run",
      );
    }
    item.processOutcome = "normal_exit";
    if (result.status === 0) item.status = "passed";
    else {
      item.error = `Compiler exited with status ${result.status}`;
      failed = true;
    }
    // A completed nonzero compiler run is a failed gate, but its diagnostics
    // do not hide the other two scoped compiler results.
    record();
  }
  NodeAssert.ok(!failed, "One or more scoped qualification lanes failed; see retained evidence");
  summary.status = "passed";
} catch (error) {
  summary.status = "failed";
  summary.error = String(error);
  process.exitCode = 1;
} finally {
  record();
}
