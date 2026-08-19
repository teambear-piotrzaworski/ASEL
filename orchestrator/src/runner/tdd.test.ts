import { describe, expect, it } from "vitest";
import type { ProjectConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { DEFAULT_TEST_FILE_PATTERNS, type CheckCommand, type CommandOutput } from "./checks.js";
import {
  HEAD_SHA_COMMAND,
  UNTRACKED_PATHS_COMMAND,
  changedPathsCommand,
  runImplementChain,
  type AgentPhaseOutcome,
  type ImplementHarness,
} from "./tdd.js";
import type { ImplementPhase, RunContext } from "./types.js";

const TEST_COMMAND = "pnpm test --run";

/** The chain logs every phase; a test run does not need to read that. */
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
  { name: "lint", command: "pnpm lint" },
  { name: "test", command: TEST_COMMAND },
];

function project(checks: CheckCommand[] = CHECKS): ProjectConfig {
  return {
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
}

function context(overrides: Partial<RunContext> = {}): RunContext {
  return {
    project: project(),
    repo: "acme/example",
    issue: {
      number: 7,
      title: "Add the importer",
      body: "Details.",
      htmlUrl: "https://github.com/acme/example/issues/7",
    },
    role: "task",
    triggerLabel: "asel:task",
    isRework: false,
    repoPath: "/repos/acme__example",
    branch: "asel/plan-42",
    epicIssue: 42,
    slice: 3,
    log: silentLogger(),
    ...overrides,
  };
}

interface Scenario {
  /** Marker printed by a phase, keyed by `<phase>#<iteration>`. */
  markers?: Record<string, Record<string, string>>;
  /** Exit codes of the test command, consumed in call order. */
  testExitCodes?: number[];
  /** Changed paths per diff call: first the red leftovers, then one per green iteration. */
  changed?: string[][];
  /** Exit codes of the other declared commands. */
  checkExitCodes?: Record<string, number>;
}

class FakeHarness implements ImplementHarness {
  readonly phases: Array<{ phase: ImplementPhase; iteration: number; prompt: string }> = [];
  readonly commands: string[] = [];
  private readonly testExitCodes: number[];
  private readonly changed: string[][];

  constructor(private readonly scenario: Scenario = {}) {
    this.testExitCodes = [...(scenario.testExitCodes ?? [])];
    this.changed = [...(scenario.changed ?? [])];
  }

  async runPhase(
    phase: ImplementPhase,
    prompt: string,
    iteration: number,
  ): Promise<AgentPhaseOutcome> {
    this.phases.push({ phase, iteration, prompt });
    return {
      marker: this.scenario.markers?.[`${phase}#${iteration}`] ?? {},
      commitCount: 2,
    };
  }

  async exec(command: string): Promise<CommandOutput> {
    this.commands.push(command);
    if (command === HEAD_SHA_COMMAND) {
      return { exitCode: 0, output: "redsha\n" };
    }
    if (command === UNTRACKED_PATHS_COMMAND) {
      return { exitCode: 0, output: "" };
    }
    if (command.startsWith("git diff --name-only")) {
      return { exitCode: 0, output: (this.changed.shift() ?? []).join("\n") };
    }
    if (command === TEST_COMMAND) {
      const exitCode = this.testExitCodes.shift() ?? 0;
      return {
        exitCode,
        output:
          exitCode === 0 ? "2 passed" : "FAIL src/importer.test.ts\nexpected undefined to be 1",
      };
    }
    return { exitCode: this.scenario.checkExitCodes?.[command] ?? 0, output: `ran ${command}` };
  }

  phaseNames(): ImplementPhase[] {
    return this.phases.map((entry) => entry.phase);
  }
}

const OPTIONS = { greenMaxIterations: 3 };

describe("implement chain: the happy path", () => {
  it("walks red, green and review in one worktree and gates on the full substrate", async () => {
    const harness = new FakeHarness({
      testExitCodes: [1, 0],
      changed: [[], ["src/importer.ts"]],
    });
    const result = await runImplementChain(context(), harness, OPTIONS);

    expect(result.ok).toBe(true);
    expect(result.blocked).toBeUndefined();
    expect(harness.phaseNames()).toEqual(["red", "green", "review"]);
    expect(result.phases).toMatchObject({
      mode: "tdd",
      lastPhase: "review",
      greenIterations: 1,
    });
    expect(result.phases?.checks.map((check) => check.name)).toEqual([
      "typecheck",
      "lint",
      "test",
    ]);
    // The verdict is the harness's own: the orchestrator ran the commands.
    expect(harness.commands.filter((command) => command === TEST_COMMAND)).toHaveLength(3);
    expect(result.commitCount).toBe(6);
    expect(result.branch).toBe("asel/plan-42");
  });

  it("asks git for the baseline right after the red phase", async () => {
    const harness = new FakeHarness({ testExitCodes: [1, 0], changed: [[], []] });
    await runImplementChain(context(), harness, OPTIONS);
    expect(harness.commands).toContain(HEAD_SHA_COMMAND);
    expect(harness.commands).toContain(changedPathsCommand("redsha"));
  });
});

describe("implement chain: the red phase has to be red", () => {
  it("stops hard when the suite passes after the red phase", async () => {
    const harness = new FakeHarness({ testExitCodes: [0] });
    const result = await runImplementChain(context(), harness, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.blocked).toBeUndefined();
    expect(result.error).toContain("passing");
    expect(harness.phaseNames()).toEqual(["red"]);
    expect(result.phases).toMatchObject({ lastPhase: "red", greenIterations: 0 });
  });

  it("ends as blocked when the red phase asks a human a question", async () => {
    const harness = new FakeHarness({ markers: { "red#1": { status: "blocked" } } });
    const result = await runImplementChain(context(), harness, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.error).toBeUndefined();
    expect(harness.phaseNames()).toEqual(["red"]);
  });
});

describe("implement chain: the green phase may not touch tests", () => {
  it("stops hard and names the test files the agent changed", async () => {
    const harness = new FakeHarness({
      testExitCodes: [1, 0],
      changed: [[], ["src/importer.ts", "src/importer.test.ts"]],
    });
    const result = await runImplementChain(context(), harness, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.blocked).toBeUndefined();
    expect(result.error).toContain("src/importer.test.ts");
    expect(result.error).not.toContain("src/importer.ts\n");
    // The suite is never run again: a suite the agent edited proves nothing.
    expect(harness.commands.filter((command) => command === TEST_COMMAND)).toHaveLength(1);
    expect(harness.phaseNames()).toEqual(["red", "green"]);
  });

  it("ignores what the red phase itself left uncommitted", async () => {
    const harness = new FakeHarness({
      testExitCodes: [1, 0],
      changed: [["src/importer.test.ts"], ["src/importer.test.ts", "src/importer.ts"]],
    });
    const result = await runImplementChain(context(), harness, OPTIONS);
    expect(result.ok).toBe(true);
  });

  it("accepts the blocked marker as the only way out of a wrong test", async () => {
    const harness = new FakeHarness({
      testExitCodes: [1],
      changed: [[]],
      markers: { "green#1": { status: "blocked" } },
    });
    const result = await runImplementChain(context(), harness, OPTIONS);

    expect(result.blocked).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.error).toBeUndefined();
    expect(harness.phaseNames()).toEqual(["red", "green"]);
  });
});

describe("implement chain: the green phase has a hard iteration limit", () => {
  it("gives up and escalates instead of trying until it works", async () => {
    const harness = new FakeHarness({
      testExitCodes: [1, 1, 1, 1],
      changed: [[], [], [], []],
    });
    const result = await runImplementChain(context(), harness, { greenMaxIterations: 3 });

    expect(result.ok).toBe(false);
    expect(result.blocked).toBeUndefined();
    expect(result.error).toContain("3");
    expect(harness.phaseNames()).toEqual(["red", "green", "green", "green"]);
    expect(result.phases).toMatchObject({ lastPhase: "green", greenIterations: 3 });
  });

  it("feeds the failing output of the previous iteration into the next prompt", async () => {
    const harness = new FakeHarness({ testExitCodes: [1, 1, 0], changed: [[], [], []] });
    await runImplementChain(context(), harness, OPTIONS);

    const second = harness.phases.filter((entry) => entry.phase === "green")[1];
    expect(second?.iteration).toBe(2);
    expect(second?.prompt).toContain("expected undefined to be 1");
  });
});

describe("implement chain: the full substrate is the last gate", () => {
  it("fails the run when a check other than the tests is red", async () => {
    const harness = new FakeHarness({
      testExitCodes: [1, 0],
      changed: [[], []],
      checkExitCodes: { "pnpm lint": 1 },
    });
    const result = await runImplementChain(context(), harness, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("lint");
    expect(result.error).toContain("ran pnpm lint");
    expect(result.phases).toMatchObject({ lastPhase: "review" });
  });

  it("ends as blocked when the review phase asks a question", async () => {
    const harness = new FakeHarness({
      testExitCodes: [1, 0],
      changed: [[], []],
      markers: { "review#1": { status: "blocked" } },
    });
    const result = await runImplementChain(context(), harness, OPTIONS);
    expect(result.blocked).toBe(true);
  });
});

describe("implement chain: no test command declared", () => {
  it("degrades to the single phase run and says so", async () => {
    const harness = new FakeHarness();
    const result = await runImplementChain(
      context({ project: project([{ name: "typecheck", command: "pnpm tsc --noEmit" }]) }),
      harness,
      OPTIONS,
    );

    expect(result.ok).toBe(true);
    expect(harness.phaseNames()).toEqual(["single"]);
    expect(result.phases).toMatchObject({ mode: "single-phase", greenIterations: 0 });
    // The substrate gate is independent of TDD: it still runs.
    expect(harness.commands).toContain("pnpm tsc --noEmit");
  });

  it("still fails the run when that substrate is red", async () => {
    const harness = new FakeHarness({ checkExitCodes: { "pnpm tsc --noEmit": 2 } });
    const result = await runImplementChain(
      context({ project: project([{ name: "typecheck", command: "pnpm tsc --noEmit" }]) }),
      harness,
      OPTIONS,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("typecheck");
  });

  it("runs no command at all for a project that declares none", async () => {
    const harness = new FakeHarness();
    const result = await runImplementChain(
      context({ project: project([]) }),
      harness,
      OPTIONS,
    );
    expect(result.ok).toBe(true);
    expect(harness.commands).toEqual([]);
    expect(harness.phaseNames()).toEqual(["single"]);
  });
});

describe("implement chain: a test command the container cannot find", () => {
  it("stops after the red phase instead of reading it as a red suite", async () => {
    const harness = new FakeHarness({ testExitCodes: [127] });
    const result = await runImplementChain(context(), harness, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.blocked).toBeUndefined();
    expect(result.error).toContain("command not found");
    expect(result.error).toContain("configuration problem");
    // Without this case the run would have gone on to implement against a
    // command that never executed.
    expect(harness.phaseNames()).toEqual(["red"]);
  });

  it("stops mid green rather than burning every iteration on it", async () => {
    const harness = new FakeHarness({
      testExitCodes: [1, 127],
      changed: [[], ["src/importer.ts"]],
    });
    const result = await runImplementChain(context(), harness, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("command not found");
    expect(harness.phaseNames()).toEqual(["red", "green"]);
    expect(result.phases).toMatchObject({ lastPhase: "green", greenIterations: 1 });
  });
});
