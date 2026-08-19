import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { DEFAULT_TEST_FILE_PATTERNS, type CheckCommand } from "./checks.js";
import { DryRunRunner, parseImplementScenario, type DryRunImplementScenario } from "./dry-run.js";
import type { RunContext } from "./types.js";

function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}

const CHECKS: CheckCommand[] = [
  { name: "typecheck", command: "pnpm tsc --noEmit" },
  { name: "test", command: "pnpm test --run" },
];

function context(checks: CheckCommand[] = CHECKS): RunContext {
  const project: ProjectConfig = {
    name: "example",
    fullName: "acme/example",
    owner: "acme",
    repoName: "example",
    image: "asel-agent-runtime:latest",
    concurrency: 1,
    env: [],
    gates: { planApproval: true },
    checks,
    testFilePatterns: [...DEFAULT_TEST_FILE_PATTERNS],
    sourceFile: "projects/example.yml",
  };
  return {
    project,
    repo: "acme/example",
    issue: {
      number: 12,
      title: "Add the importer",
      body: "Details.",
      htmlUrl: "https://github.com/acme/example/issues/12",
    },
    role: "task",
    triggerLabel: "asel:task",
    isRework: false,
    repoPath: "/repos/acme__example",
    branch: "asel/plan-42",
    epicIssue: 42,
    slice: 1,
    log: silentLogger(),
  };
}

function runner(scenario: DryRunImplementScenario): DryRunRunner {
  return new DryRunRunner({
    labels: { taskLabel: "asel:task", sliceLabelPrefix: "asel:slice-", sliceLabelColor: "c5def5" },
    greenMaxIterations: 3,
    implementScenario: scenario,
  });
}

describe("parseImplementScenario", () => {
  it("falls back to the successful chain for anything it does not know", () => {
    expect(parseImplementScenario(undefined)).toBe("success");
    expect(parseImplementScenario("nonsense")).toBe("success");
    expect(parseImplementScenario(" BLOCKED ")).toBe("blocked");
  });
});

describe("DRY_RUN implementation chain", () => {
  it("walks the whole chain and succeeds", async () => {
    const result = await runner("success").runImplement(context());
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("DRY_RUN");
    expect(result.phases).toMatchObject({ mode: "tdd", lastPhase: "review", greenIterations: 1 });
  });

  it("simulates each way the chain can stop, so every label can be exercised", async () => {
    const blocked = await runner("blocked").runImplement(context());
    expect(blocked).toMatchObject({ ok: false, blocked: true });

    const alreadyGreen = await runner("red-phase-green").runImplement(context());
    expect(alreadyGreen.ok).toBe(false);
    expect(alreadyGreen.error).toContain("passing");

    const guard = await runner("test-guard").runImplement(context());
    expect(guard.ok).toBe(false);
    expect(guard.error).toContain("src/dry-run.test.ts");

    const limit = await runner("green-limit").runImplement(context());
    expect(limit.ok).toBe(false);
    expect(limit.phases?.greenIterations).toBe(3);

    const substrate = await runner("checks-red").runImplement(context());
    expect(substrate.ok).toBe(false);
    expect(substrate.error).toContain("typecheck");
  });

  it("degrades to one phase when the project declares no test command", async () => {
    const result = await runner("success").runImplement(
      context([{ name: "typecheck", command: "pnpm tsc --noEmit" }]),
    );
    expect(result.ok).toBe(true);
    expect(result.phases).toMatchObject({ mode: "single-phase" });
  });
});
