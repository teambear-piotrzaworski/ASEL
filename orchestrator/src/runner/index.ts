/** Runner selection: DRY_RUN swaps every real adapter for a logging stub. */
import { LABEL_COLORS } from "../labels.js";
import { labelsFor, sliceLabelPrefix } from "../machine.js";
import { DryRunRunner, parseImplementScenario } from "./dry-run.js";
import { SandcastleRunner, type ContainerUser } from "./sandcastle.js";
import { DEFAULT_GREEN_MAX_ITERATIONS } from "./tdd.js";
import type { TaskPromptLabels } from "./prompts.js";
import type { Runners } from "./types.js";

export * from "./types.js";
export * from "./checks.js";
export { DryRunRunner } from "./dry-run.js";
export { SandcastleRunner, SandcastleNotIntegratedError } from "./sandcastle.js";
export { runImplementChain, DEFAULT_GREEN_MAX_ITERATIONS } from "./tdd.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const DEFAULT_MAX_ITERATIONS = 5;

/** Reads a positive integer from the environment, undefined when unusable. */
export function optionalPositiveInt(value: string | undefined): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

/** Reads a positive integer from the environment, or falls back. */
function positiveInt(value: string | undefined, fallback: number): number {
  return optionalPositiveInt(value) ?? fallback;
}

/**
 * UID/GID the agent containers must run as, read from the environment.
 *
 * The orchestrator cannot work them out for itself: in compose it runs as root
 * (it needs the docker socket), so its own uid says nothing about the host user
 * whose files the agents will be writing. `asel.sh` knows that user - it is the
 * one who runs `./asel.sh build`, and it is the uid baked into the agent image -
 * so it exports the pair and compose passes it in.
 *
 * ALL OR NOTHING on purpose. A uid without a gid would leave the group at
 * `process.getgid()`, which is 0 inside the orchestrator container: the agent
 * would run as `<host uid>:0` and every file it wrote into the bind mounted
 * worktree would end up group owned by root on the host. Half an answer is
 * worse than none here, because none at least degrades to one documented
 * default instead of a mix of two.
 *
 * Zero is rejected along with anything else that is not a positive integer: the
 * agent image runs a non root user by construction, so uid 0 can only be a
 * misconfiguration - typically somebody exporting the orchestrator's own uid.
 */
export function resolveContainerUser(env: NodeJS.ProcessEnv): ContainerUser | undefined {
  const uid = optionalPositiveInt(env["ASEL_AGENT_UID"]);
  const gid = optionalPositiveInt(env["ASEL_AGENT_GID"]);
  if (uid === undefined || gid === undefined) {
    return undefined;
  }
  return { uid, gid };
}

/**
 * One object implements every run kind today (dry run stub or sandcastle
 * adapter). The interfaces stay separate so a kind can get its own runtime
 * later without touching the scheduler.
 */
function asRunners(runner: DryRunRunner | SandcastleRunner): Runners {
  return {
    wayfinder: runner,
    adr: runner,
    prd: runner,
    slices: runner,
    tasks: runner,
    implement: runner,
  };
}

export function createRunners(options: { dryRun: boolean; labelPrefix: string }): Runners {
  const labels: TaskPromptLabels = {
    taskLabel: labelsFor(options.labelPrefix).task,
    sliceLabelPrefix: sliceLabelPrefix(options.labelPrefix),
    sliceLabelColor: LABEL_COLORS.slice,
  };
  // Hard cap on the green phase of an implementation run: after it the run
  // stops and a human is called in, so it is deliberately small.
  const greenMaxIterations = positiveInt(
    process.env["ASEL_GREEN_MAX_ITERATIONS"],
    DEFAULT_GREEN_MAX_ITERATIONS,
  );
  if (options.dryRun) {
    return asRunners(
      new DryRunRunner({
        labels,
        greenMaxIterations,
        implementScenario: parseImplementScenario(process.env["ASEL_DRY_RUN_IMPLEMENT"]),
      }),
    );
  }
  return asRunners(
    new SandcastleRunner({
      model: process.env["ASEL_AGENT_MODEL"] ?? DEFAULT_MODEL,
      maxIterations: positiveInt(process.env["ASEL_MAX_ITERATIONS"], DEFAULT_MAX_ITERATIONS),
      labels,
      greenMaxIterations,
      containerUser: resolveContainerUser(process.env),
    }),
  );
}
