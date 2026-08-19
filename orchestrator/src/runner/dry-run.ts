/**
 * DRY_RUN implementation: logs what a real run WOULD do and reports success.
 * Used to exercise the label state machine without spending tokens.
 *
 * The implementation run is the one that does more than log. It goes through
 * the REAL phase chain (runner/tdd.ts) with a scripted harness, so the red
 * gate, the green guard, the iteration limit and the substrate gate all execute
 * exactly as they would against Docker. `ASEL_DRY_RUN_IMPLEMENT` picks which
 * ending to simulate, which is how the `asel:failed` and `asel:blocked` paths of
 * the state machine get exercised without a container.
 */
import { testCheck, type CommandOutput } from "./checks.js";
import {
  adrPrompt,
  implementPrompt,
  prdPrompt,
  slicesPrompt,
  tasksPrompt,
  wayfinderPrompt,
  type TaskPromptLabels,
} from "./prompts.js";
import {
  HEAD_SHA_COMMAND,
  UNTRACKED_PATHS_COMMAND,
  changedPathsCommand,
  runImplementChain,
  type AgentPhaseOutcome,
  type ImplementHarness,
} from "./tdd.js";
import type {
  AdrResult,
  AdrRunner,
  ImplementPhase,
  ImplementResult,
  ImplementRunner,
  PrdResult,
  PrdRunner,
  RunContext,
  SlicesResult,
  SlicesRunner,
  TasksResult,
  TasksRunner,
  WayfinderResult,
  WayfinderRunner,
} from "./types.js";

/**
 * Endings a dry run can simulate. `success` is the default; the others exist so
 * a human can drive an issue into every terminal label without a container.
 */
export type DryRunImplementScenario =
  | "success"
  | "blocked"
  | "red-phase-green"
  | "test-guard"
  | "green-limit"
  | "checks-red";

const SCENARIOS: readonly DryRunImplementScenario[] = [
  "success",
  "blocked",
  "red-phase-green",
  "test-guard",
  "green-limit",
  "checks-red",
];

export function parseImplementScenario(value: string | undefined): DryRunImplementScenario {
  const normalized = (value ?? "").trim().toLowerCase();
  return (SCENARIOS as readonly string[]).includes(normalized)
    ? (normalized as DryRunImplementScenario)
    : "success";
}

export interface DryRunRunnerOptions {
  labels: TaskPromptLabels;
  greenMaxIterations: number;
  /** Which ending the implementation chain should simulate. */
  implementScenario?: DryRunImplementScenario;
}

/**
 * Scripted harness. It never starts a container: it answers the harness
 * commands the chain issues, in the shape git would.
 */
class DryRunImplementHarness implements ImplementHarness {
  private greenIterations = 0;

  constructor(
    private readonly context: RunContext,
    private readonly scenario: DryRunImplementScenario,
  ) {}

  async runPhase(
    phase: ImplementPhase,
    prompt: string,
    iteration: number,
  ): Promise<AgentPhaseOutcome> {
    this.context.log.info(`DRY_RUN would run the ${phase} phase`, {
      iteration,
      branch: this.context.branch,
      scenario: this.scenario,
    });
    this.context.log.debug("DRY_RUN prompt", { prompt });
    if (phase === "green") {
      this.greenIterations = iteration;
    }
    const blocked = this.scenario === "blocked" && phase === "green";
    return {
      marker: blocked ? { status: "blocked" } : {},
      commitCount: 1,
    };
  }

  async exec(command: string): Promise<CommandOutput> {
    const output = (exitCode: number, text: string): CommandOutput => {
      this.context.log.debug("DRY_RUN harness command", { command, exitCode });
      return { exitCode, output: text };
    };

    if (command === HEAD_SHA_COMMAND) {
      return output(0, "0000000000000000000000000000000000000000");
    }
    if (command === UNTRACKED_PATHS_COMMAND) {
      return output(0, "");
    }
    if (command.startsWith(changedPathsCommand(""))) {
      // The guard scenario reports a test file the green phase must not touch.
      const changed =
        this.scenario === "test-guard" && this.greenIterations > 0
          ? "src/dry-run.ts\nsrc/dry-run.test.ts"
          : "src/dry-run.ts";
      return output(0, changed);
    }

    const test = testCheck(this.context.project.checks);
    if (test !== null && command === test.command) {
      return this.testCommandOutput(output);
    }
    if (this.scenario === "checks-red") {
      return output(1, `DRY_RUN: ${command} would be red\nsimulated failure`);
    }
    return output(0, `DRY_RUN: ${command} would run here`);
  }

  /**
   * Red before the green phase, green after it. The scenarios bend exactly one
   * of those two answers, which is what makes each gate observable.
   */
  private testCommandOutput(
    output: (exitCode: number, text: string) => CommandOutput,
  ): CommandOutput {
    if (this.scenario === "red-phase-green") {
      return output(0, "DRY_RUN: the suite would already pass");
    }
    if (this.greenIterations === 0) {
      return output(1, "DRY_RUN: the suite would fail here\n1 failed");
    }
    if (this.scenario === "green-limit") {
      return output(1, "DRY_RUN: the suite would stay red\n1 failed");
    }
    return output(0, "DRY_RUN: the suite would pass");
  }
}

export class DryRunRunner
  implements WayfinderRunner, AdrRunner, PrdRunner, SlicesRunner, TasksRunner, ImplementRunner
{
  private readonly labels: TaskPromptLabels;
  private readonly greenMaxIterations: number;
  private readonly implementScenario: DryRunImplementScenario;

  constructor(options: DryRunRunnerOptions) {
    this.labels = options.labels;
    this.greenMaxIterations = options.greenMaxIterations;
    this.implementScenario = options.implementScenario ?? "success";
  }

  private logIntent(context: RunContext, kind: string, prompt: string): void {
    context.log.info(`DRY_RUN would start a ${kind} run`, {
      repo: context.repo,
      issue: context.issue.number,
      image: context.project.image,
      repoPath: context.repoPath,
      branch: context.branch,
      epicIssue: context.epicIssue,
      slice: context.slice,
      trigger: context.triggerLabel,
      isRework: context.isRework,
    });
    context.log.debug("DRY_RUN prompt", { prompt });
  }

  async runWayfinder(context: RunContext): Promise<WayfinderResult> {
    this.logIntent(context, "wayfinder", wayfinderPrompt(context));
    return {
      ok: true,
      summary: "DRY_RUN: wayfinder run skipped, no map was created",
      decisionCount: 0,
    };
  }

  async runAdr(context: RunContext): Promise<AdrResult> {
    this.logIntent(context, "adr", adrPrompt(context));
    return {
      ok: true,
      summary: `DRY_RUN: ADR run skipped, nothing was committed to ${context.branch}`,
      adrCount: 0,
      branch: context.branch,
    };
  }

  async runPrd(context: RunContext): Promise<PrdResult> {
    this.logIntent(context, "prd", prdPrompt(context));
    return {
      ok: true,
      summary: `DRY_RUN: PRD run skipped, nothing was committed to ${context.branch}`,
      prdFileCount: 0,
      branch: context.branch,
    };
  }

  async runSlices(context: RunContext): Promise<SlicesResult> {
    this.logIntent(context, "slices", slicesPrompt(context));
    return {
      ok: true,
      summary: "DRY_RUN: slicing run skipped, no plan was written",
      sliceCount: 0,
      branch: context.branch,
    };
  }

  async runTasks(context: RunContext): Promise<TasksResult> {
    this.logIntent(context, "tasks", tasksPrompt(context, this.labels));
    return {
      ok: true,
      summary: "DRY_RUN: task creation run skipped, no task issues were created",
      sliceCount: 0,
      taskIssueNumbers: [],
    };
  }

  /**
   * The real chain over a scripted harness, so DRY_RUN exercises the phase
   * order and every gate rather than a summary of them. The prompt of each
   * phase still goes to the debug log, exactly like the other kinds.
   */
  async runImplement(context: RunContext): Promise<ImplementResult> {
    this.logIntent(context, "implement", implementPrompt(context));
    const harness = new DryRunImplementHarness(context, this.implementScenario);
    const result = await runImplementChain(context, harness, {
      greenMaxIterations: this.greenMaxIterations,
    });
    return { ...result, summary: `DRY_RUN: ${result.summary}` };
  }
}
