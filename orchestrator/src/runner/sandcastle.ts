/**
 * Sandcastle / Wayfinder adapter.
 *
 * API researched against the upstream README (@ai-hero/sandcastle, 0.12.x):
 *
 *   import { run, createSandbox, claudeCode } from "@ai-hero/sandcastle";
 *   import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
 *
 *   const result = await run({
 *     agent: claudeCode("claude-opus-4-8", { effort: "high", env: {} }),
 *     sandbox: docker({ imageName: "asel-agent-runtime:latest", env: {} }),
 *     cwd: "/data/repos/owner-name",
 *     branchStrategy: { type: "branch", branch: "asel/plan-42" },
 *     prompt: "...",
 *     maxIterations: 5,
 *   });
 *   // result: { iterations, stdout, commits: [{ sha }], branch, completionSignal }
 *
 * The implementation run needs more than one agent invocation on ONE worktree,
 * so it uses the other entry point the README documents for exactly that:
 *
 *   const sandbox = await createSandbox({ branch, sandbox: docker(...), cwd });
 *   await sandbox.run({ agent, prompt, maxIterations });   // repeatable
 *   await sandbox.exec("pnpm test --run");                 // ExecResult
 *   await sandbox.close();
 *
 * README, verbatim: "Commits from all run() calls accumulate on the same
 * branch. The sandbox container stays alive between runs", and `sandbox.exec()`
 * "lets the harness run shell commands directly in the same warm sandbox -
 * handy for gating an implement step on a quick verification before kicking off
 * the review". That is precisely the red / green / review chain in tdd.ts.
 *
 * Wayfinder has no programmatic API at all: it is a Claude Code skill invoked
 * as `/wayfinder` inside a session, so the wayfinder run is a Sandcastle run
 * with a slash command in the prompt.
 *
 * Every run of one plan (adr, prd, slices, tasks and the implementation of each
 * task) gets the same branch name from the scheduler, so all of it lands on one
 * branch. The published 0.12.0 types are the best evidence so far that an
 * EXISTING branch is continued rather than re-forked: `NamedBranchStrategy`
 * documents `baseBranch` as the starting point used "only when the branch
 * doesn't already exist - ignored otherwise", and puts the freshness of the ref
 * on the caller ("e.g. `git fetch`", which is what git-sync.ts does before
 * every run). Still unproven on a live run, which is why the prompts also tell
 * the agent to check the branch out and to push it at the end (sandcastle
 * brings commits back locally only).
 *
 * The adapter is deliberately kept behind a feature flag (ASEL_ENABLE_SANDCASTLE)
 * even now that the dependency is installed: it is the one switch that stops a
 * misconfigured machine from starting real containers. Some of it is still
 * unverified on a live run (output capture, phase to phase worktree state).
 *
 * Two options are passed that the README never mentions, both read out of the
 * installed sources rather than the docs: `containerUid`/`containerGid` on the
 * docker provider (see buildDockerOptions) and `completionSignal` on every run
 * (see COMPLETION_SIGNAL). Neither has a safe default for this deployment.
 *
 * The library is IMPORTED FOR ITS TYPES but LOADED DYNAMICALLY at runtime. The
 * types make `tsc` check this file against the real 0.12.x API instead of
 * against a hand written guess; the dynamic load keeps DRY_RUN working on a
 * machine where the package is broken or absent, which is exactly the mode a
 * human reaches for when something is broken.
 *
 * Two things are deliberately NOT treated as failures here: a run that brings
 * back no commits (an ADR run may legitimately find nothing worth recording)
 * and a missing ASEL_RESULT line (the counts only feed the summary). A run
 * fails when it throws, and it blocks when it says `status=blocked`.
 */
import type {
  AgentProvider,
  ClaudeCodeOptions,
  CreateSandboxOptions,
  RunOptions,
  RunResult,
  Sandbox,
  SandboxProvider,
  SandboxRunResult,
} from "@ai-hero/sandcastle";
import type { DockerOptions } from "@ai-hero/sandcastle/sandboxes/docker";
import { createGitExec, type GitExec } from "../git-sync.js";
import { resetWorktree, worktreeExists } from "../worktree-reset.js";
import type { CommandOutput } from "./checks.js";
import {
  adrPrompt,
  isBlockedResult,
  parseResultMarker,
  prdPrompt,
  RESULT_MARKER_PREFIX,
  slicesPrompt,
  tasksPrompt,
  wayfinderPrompt,
  type TaskPromptLabels,
} from "./prompts.js";
import {
  runImplementChain,
  type AgentPhaseOutcome,
  type ImplementHarness,
} from "./tdd.js";
import { blockedResult } from "./types.js";
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

const SANDCASTLE_PACKAGE = "@ai-hero/sandcastle";
const SANDCASTLE_DOCKER_PACKAGE = "@ai-hero/sandcastle/sandboxes/docker";

/**
 * Substring that ends the iteration loop of one agent invocation.
 *
 * Sandcastle calls the agent again and again until it sees this string or until
 * `maxIterations` is spent. The matching rule is not a guess: the published type
 * says "Substring(s) the agent emits to stop the iteration loop early. Matched
 * via `includes` against agent output", and `dist/index.js` does exactly that -
 * `completionSignals.find((sig) => agentOutput.includes(sig))`, where
 * `agentOutput` is `resultText || execResult.stdout`, i.e. the very string
 * `extractOutputText()` reads the marker out of.
 *
 * Substring matching is what makes the cheap option possible: every prompt
 * ALREADY ends with a line starting with ASEL_RESULT, so handing that prefix
 * over as the signal adds nothing to any prompt and makes the loop stop on
 * exactly the string this adapter needs in order to have a result at all. The
 * failure mode is the old one: no marker, no early stop, the run burns its
 * iterations exactly as it does today.
 *
 * Rejected: keeping the default `<promise>COMPLETE</promise>` and telling every
 * prompt to print it. That is a second thing the agent has to remember, a second
 * thing that can go missing, and the two can disagree - a run that prints the
 * signal but not the marker would stop early with nothing to read.
 */
export const COMPLETION_SIGNAL = RESULT_MARKER_PREFIX;

/**
 * Grace window, in seconds, after the signal is first SEEN in the stream.
 *
 * The signal is matched in two places, and only one of them ends the loop.
 * `dist/index.js` matches it inside the per line callback against everything
 * the agent has said so far (`accumulatedOutput.includes(sig)`), and that match
 * only flips the timers; the loop itself matches against the FINAL result text
 * after the process exits. So an agent that narrates "I will finish with the
 * ASEL_RESULT line" cannot end the run early - but it does trip the timer
 * switch, and from that moment the budget per output line drops from
 * `idleTimeoutSeconds` (600 by default) to `completionTimeoutSeconds` (60),
 * after which the iteration is force-completed mid work.
 *
 * A widened signal makes that narration likely, and a test suite is easily
 * quieter than 60 seconds, so the default would cut real work off. Setting the
 * grace window to the idle timeout means a false positive costs nothing the run
 * was not already paying: a genuinely hung agent still gets killed, just on the
 * idle budget instead of a shorter one.
 */
export const COMPLETION_GRACE_SECONDS = 600;

/** UID and GID the agent container has to run as. */
export interface ContainerUser {
  uid: number;
  gid: number;
}

/** Logged once per run when the host UID/GID never reached the adapter. */
export const MISSING_CONTAINER_USER_WARNING =
  "ASEL_AGENT_UID/ASEL_AGENT_GID are not set, so the agent container falls back " +
  "to the sandcastle default (the orchestrator's own uid, which is root here)";

/**
 * The slice of the library this adapter uses. Written against the published
 * types, so a signature change in a future version breaks the build here rather
 * than at three in the morning inside a container.
 */
interface SandcastleModule {
  run(options: RunOptions): Promise<RunResult>;
  createSandbox(options: CreateSandboxOptions): Promise<Sandbox>;
  claudeCode(model: string, options?: ClaudeCodeOptions): AgentProvider;
}

interface SandcastleDockerModule {
  docker(options?: DockerOptions): SandboxProvider;
}

export class SandcastleNotIntegratedError extends Error {
  constructor(reason: string) {
    super(
      `sandcastle integration is not active: ${reason}. ` +
        "Run with DRY_RUN=1, or set ASEL_ENABLE_SANDCASTLE=1 to allow real containers.",
    );
    this.name = "SandcastleNotIntegratedError";
  }
}

export interface SandcastleRunnerOptions {
  /** Claude model passed to claudeCode(). */
  model: string;
  /** Upper bound on agent iterations per run. */
  maxIterations: number;
  /** Labels injected into the tasks prompt. */
  labels: TaskPromptLabels;
  /** Hard cap on the green phase of an implementation run. */
  greenMaxIterations: number;
  /**
   * UID/GID the agent containers run as. Undefined means the host values never
   * arrived and the sandcastle default takes over; see buildDockerOptions().
   */
  containerUser?: ContainerUser | undefined;
}

/**
 * Docker provider options for one run.
 *
 * `containerUid`/`containerGid` are passed EXPLICITLY whenever the host
 * resolved them, because the default is wrong for this deployment and wrong
 * quietly. `dist/sandboxes/docker.js` reads
 * `options?.containerUid ?? process.getuid?.() ?? 1000`, uses the pair as the
 * `--user` value and compares the uid with the one baked into the image
 * (`checkImageUid`). The orchestrator runs as root inside its own container
 * because it needs the docker socket, so `process.getuid()` is 0, while the
 * agent image carries a non root user `agent` with the UID of the host user who
 * ran `./asel.sh build`.
 *
 * The pre-flight does NOT save us from that: `checkImageUid` parses
 * `{{.Config.User}}` and gives up on `isNaN`, and images/agent-runtime declares
 * `USER agent` by NAME, so the check resolves without comparing anything. The
 * real symptom would therefore be a run that starts as root and leaves root
 * owned files in a bind mounted worktree on the host - not a clean rejection.
 */
export function buildDockerOptions(options: {
  imageName: string;
  env: Record<string, string>;
  containerUser?: ContainerUser | undefined;
}): DockerOptions {
  const base: DockerOptions = { imageName: options.imageName, env: options.env };
  if (options.containerUser === undefined) {
    return base;
  }
  return {
    ...base,
    containerUid: options.containerUser.uid,
    containerGid: options.containerUser.gid,
  };
}

/** Reads a non negative integer out of the ASEL_RESULT marker. */
function markerNumber(marker: Record<string, string>, key: string): number {
  const value = Number(marker[key] ?? "0");
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Branch the agent says it pushed. It should equal the branch we handed it; a
 * mismatch means the plan branch did not get the commits, so it is worth a
 * warning even though the run itself succeeded.
 */
function reportedBranch(marker: Record<string, string>, context: RunContext): string {
  const reported = (marker["branch"] ?? "").trim();
  if (reported === "" || reported === context.branch) {
    return context.branch;
  }
  context.log.warn("agent reported a different branch than the one it was given", {
    expected: context.branch,
    reported,
  });
  return reported;
}

export class SandcastleRunner
  implements WayfinderRunner, AdrRunner, PrdRunner, SlicesRunner, TasksRunner, ImplementRunner
{
  private readonly options: SandcastleRunnerOptions;
  /**
   * Git executor for the worktree reset below. Its own, and not the one in
   * index.ts: that one is chained per clone around the CLONE sync, while this
   * runs inside a single run, on the one directory that run is about to be
   * handed.
   */
  private readonly git: GitExec = createGitExec();

  constructor(options: SandcastleRunnerOptions) {
    this.options = options;
  }

  async runWayfinder(context: RunContext): Promise<WayfinderResult> {
    const marker = await this.execute(context, wayfinderPrompt(context));
    if (isBlockedResult(marker)) {
      return blockedResult("wayfinder run");
    }
    const decisions = markerNumber(marker, "decisions_open");
    const mapIssue = markerNumber(marker, "map_issue");
    const result: WayfinderResult = {
      ok: true,
      summary: `Wayfinder map updated, ${decisions} decision tickets open`,
      decisionCount: decisions,
    };
    if (mapIssue > 0) {
      result.mapIssueNumber = mapIssue;
    }
    return result;
  }

  async runAdr(context: RunContext): Promise<AdrResult> {
    const marker = await this.execute(context, adrPrompt(context));
    if (isBlockedResult(marker)) {
      return blockedResult("ADR run");
    }
    const adrs = markerNumber(marker, "adrs");
    const branch = reportedBranch(marker, context);
    // Zero ADRs is a legitimate outcome: the agent found no decision worth
    // recording, so it wrote nothing and committed nothing. The pipeline moves
    // on to the PRD exactly as it would after ten records.
    return {
      ok: true,
      summary:
        adrs === 0
          ? "No architecture decision was worth recording, nothing was committed"
          : `${adrs} architecture decision records committed to ${branch}`,
      adrCount: adrs,
      branch,
    };
  }

  async runPrd(context: RunContext): Promise<PrdResult> {
    const marker = await this.execute(context, prdPrompt(context));
    if (isBlockedResult(marker)) {
      return blockedResult("PRD run");
    }
    const files = markerNumber(marker, "prd_files");
    const branch = reportedBranch(marker, context);
    return {
      ok: true,
      summary: `Product requirements committed to ${branch}, ${files} files`,
      prdFileCount: files,
      branch,
    };
  }

  async runSlices(context: RunContext): Promise<SlicesResult> {
    const marker = await this.execute(context, slicesPrompt(context));
    if (isBlockedResult(marker)) {
      return blockedResult("slicing run");
    }
    const slices = markerNumber(marker, "slices");
    const branch = reportedBranch(marker, context);
    return {
      ok: true,
      summary: `Plan committed to ${branch}, split into ${slices} vertical slices`,
      sliceCount: slices,
      branch,
    };
  }

  async runTasks(context: RunContext): Promise<TasksResult> {
    const marker = await this.execute(context, tasksPrompt(context, this.options.labels));
    if (isBlockedResult(marker)) {
      return blockedResult("task creation run");
    }
    const slices = markerNumber(marker, "slices");
    const tasks = (marker["tasks"] ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
    return {
      ok: true,
      summary: `${tasks.length} task issues created from ${slices} slices`,
      sliceCount: slices,
      taskIssueNumbers: tasks,
    };
  }

  /**
   * The one run kind that is a CHAIN of agent phases rather than a single
   * prompt (red, green, review; see tdd.ts). It keeps one sandbox open for all
   * of them, so every phase sees the same worktree, the same branch and the
   * same warm container, and the harness can run the project's own commands
   * between phases.
   *
   * The interface does not change: the orchestrator still calls this once and
   * still gets one result. Everything about the phases stays in here.
   */
  async runImplement(context: RunContext): Promise<ImplementResult> {
    assertIntegrationEnabled();

    const { createSandbox, claudeCode } = await loadSandcastle();
    const { docker } = await loadSandcastleDocker();

    context.log.info("starting sandcastle implementation sandbox", {
      repo: context.repo,
      issue: context.issue.number,
      image: context.project.image,
      branch: context.branch,
      checks: context.project.checks.map((check) => check.name).join(",") || "none",
    });
    warnMissingContainerUser(context, this.options.containerUser);

    // Before the sandbox, because the sandbox is what inherits the mess.
    // Sandcastle keeps the worktree of this branch between runs and reuses it
    // as-is: an interrupted run leaves it dirty and possibly on a commit origin
    // no longer has, and its own attempt to refresh it fetches without a
    // credential and gives up. git-sync.ts refreshed the CLONE before this run
    // started; this does the same for the worktree, which is the directory the
    // agent actually works in. See worktree-reset.ts.
    await resetWorktree(
      {
        repoPath: context.repoPath,
        branch: context.branch,
        token: process.env["GITHUB_TOKEN"],
      },
      { exists: worktreeExists, exec: this.git, log: context.log.child("worktree") },
    );

    // The agent env goes into the CONTAINER env here, not only into the agent
    // provider. Verified against the installed 0.12.0 sources: `sandbox.run()`
    // launches the agent with `sandbox.exec(printCmd.command)` and never passes
    // `provider.env` along, and `createSandbox` builds the container env with
    // `agentProviderEnv: {}` - so a credential handed only to claudeCode() is
    // invisible to the CLI on this path ("Not logged in"). The `run()` entry
    // point does merge it into the container env, which is why the planning
    // runs never hit this. `docker exec` inherits the container env, so putting
    // the credential there reaches every phase invocation.
    const sandbox = await createSandbox({
      branch: context.branch,
      sandbox: docker(
        buildDockerOptions({
          imageName: context.project.image,
          env: { ...sandboxEnv(context), ...agentEnv() },
          containerUser: this.options.containerUser,
        }),
      ),
      cwd: context.repoPath,
    });

    try {
      const harness = new SandboxImplementHarness(
        sandbox,
        claudeCode(this.options.model, { env: agentEnv() }),
        this.options.maxIterations,
        context,
      );
      return await runImplementChain(context, harness, {
        greenMaxIterations: this.options.greenMaxIterations,
      });
    } finally {
      try {
        await sandbox.close();
      } catch (error) {
        // Losing a container is not worth losing the run result over.
        context.log.warn("cannot close the sandbox", { error: (error as Error).message });
      }
    }
  }

  /** Shared run body: build providers, call run(), pull the result marker out. */
  private async execute(context: RunContext, prompt: string): Promise<Record<string, string>> {
    assertIntegrationEnabled();

    const { run, claudeCode } = await loadSandcastle();
    const { docker } = await loadSandcastleDocker();

    context.log.info("starting sandcastle run", {
      repo: context.repo,
      issue: context.issue.number,
      image: context.project.image,
      branch: context.branch,
    });
    warnMissingContainerUser(context, this.options.containerUser);

    const result = await run({
      agent: claudeCode(this.options.model, { env: agentEnv() }),
      sandbox: docker(
        buildDockerOptions({
          imageName: context.project.image,
          env: sandboxEnv(context),
          containerUser: this.options.containerUser,
        }),
      ),
      cwd: context.repoPath,
      branchStrategy: { type: "branch", branch: context.branch },
      prompt,
      // Without a signal the agent is re-invoked maxIterations times even
      // though the first invocation already printed its result marker.
      completionSignal: COMPLETION_SIGNAL,
      completionTimeoutSeconds: COMPLETION_GRACE_SECONDS,
      maxIterations: this.options.maxIterations,
    });

    context.log.info("sandcastle run finished", {
      branch: result.branch,
      commits: result.commits.length,
    });

    return parseResultMarker(extractOutputText(result));
  }
}

/**
 * Implementation harness backed by one long lived sandbox.
 *
 * TO VERIFY ON A LIVE RUN: the README documents repeated `sandbox.run()` on one
 * sandbox and `sandbox.exec()` alongside it, and says commits accumulate on the
 * same branch. What it does NOT spell out is whether an agent run leaves the
 * worktree in a state the next one picks up cleanly (session isolation, git
 * index, dependency installs done by a phase). If a phase turns out to start
 * from a fresh checkout, the chain still works - every phase reads the branch -
 * but the guard baseline would have to move from a sha to a diff against the
 * merge base. The whole adapter sits behind ASEL_ENABLE_SANDCASTLE.
 */
class SandboxImplementHarness implements ImplementHarness {
  constructor(
    private readonly sandbox: Sandbox,
    private readonly agent: AgentProvider,
    private readonly maxIterations: number,
    private readonly context: RunContext,
  ) {}

  async runPhase(
    phase: ImplementPhase,
    prompt: string,
    iteration: number,
  ): Promise<AgentPhaseOutcome> {
    // The signal applies to the phases too, and it matters more here than
    // anywhere else. Every phase prompt ends with the same ASEL_RESULT line
    // (implementClosing() in prompts.ts), and the green phase already has its
    // own retry loop in tdd.ts driven by the harness running the test command -
    // so the inner iterations were pure duplication: up to maxIterations agent
    // invocations per outer green iteration, gated on nothing.
    const result = await this.sandbox.run({
      agent: this.agent,
      prompt,
      completionSignal: COMPLETION_SIGNAL,
      completionTimeoutSeconds: COMPLETION_GRACE_SECONDS,
      maxIterations: this.maxIterations,
    });
    this.context.log.info("implementation phase finished", {
      phase,
      iteration,
      commits: result.commits.length,
      agentIterations: result.iterations.length,
    });
    return {
      marker: parseResultMarker(extractOutputText(result)),
      commitCount: result.commits.length,
    };
  }

  async exec(command: string): Promise<CommandOutput> {
    const result = await this.sandbox.exec(command);
    this.context.log.debug("harness command", { command, exitCode: result.exitCode });
    return {
      exitCode: result.exitCode,
      output: [result.stdout, result.stderr].filter((part) => part !== "").join("\n"),
    };
  }
}

/**
 * Says out loud that the run is about to use the sandcastle default UID.
 *
 * A warning rather than a refusal: a machine where the orchestrator itself runs
 * as the host user (outside compose) is a perfectly good setup, and the default
 * is right there. Per run, not once at startup, because the log line has to sit
 * next to the run it explains.
 */
function warnMissingContainerUser(context: RunContext, user: ContainerUser | undefined): void {
  if (user === undefined) {
    context.log.warn(MISSING_CONTAINER_USER_WARNING, { image: context.project.image });
  }
}

/**
 * Environment handed to the agent provider. Sandcastle also resolves
 * .sandcastle/.env inside the target repo; provider env wins for shared keys.
 */
function agentEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const oauth = process.env["CLAUDE_CODE_OAUTH_TOKEN"];
  if (oauth !== undefined && oauth !== "") {
    env["CLAUDE_CODE_OAUTH_TOKEN"] = oauth;
  }
  return env;
}

/**
 * Environment handed to the sandbox provider. The agent pushes its branch and
 * creates task issues itself (git and `gh`), so the container needs a GitHub
 * token plus whatever the project registry declares in its `env` list.
 */
function sandboxEnv(context: RunContext): Record<string, string> {
  const env: Record<string, string> = {};
  const token = process.env["GITHUB_TOKEN"];
  if (token !== undefined && token !== "") {
    env["GH_TOKEN"] = token;
  }
  // Agent env and sandbox env must not share a key: sandcastle throws on the
  // overlap rather than picking a winner. A project that declares the agent
  // token in its passthrough list would trip that, so the agent side wins here.
  const agentKeys = new Set(Object.keys(agentEnv()));
  for (const name of context.project.env) {
    const value = process.env[name];
    if (value !== undefined && !agentKeys.has(name)) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * `result.stdout` is "combined stdout output from all agent iterations", which
 * is exactly where the ASEL_RESULT line has to be found. In 0.12.0 it is a
 * required string, so this is the one and only source.
 *
 * The scan over `iterations` stays as a belt: in 0.12.0 an IterationResult
 * carries only a session id, a session file path and token counts, so it can
 * never produce the marker - but it costs nothing, and a version that puts text
 * back into the iterations would be silently unreadable without it.
 */
function extractOutputText(result: RunResult | SandboxRunResult): string {
  if (typeof result.stdout === "string" && result.stdout !== "") {
    return result.stdout;
  }
  const chunks: string[] = [];
  for (const iteration of result.iterations) {
    for (const value of Object.values(iteration as Record<string, unknown>)) {
      if (typeof value === "string") {
        chunks.push(value);
      }
    }
  }
  return chunks.join("\n");
}

function assertIntegrationEnabled(): void {
  // TODO(slice-2/3): drop this flag once a live run has been verified end to end.
  if (process.env["ASEL_ENABLE_SANDCASTLE"] !== "1") {
    throw new SandcastleNotIntegratedError("ASEL_ENABLE_SANDCASTLE is not set to 1");
  }
}

/**
 * Loaded dynamically from a non literal specifier so the orchestrator builds
 * and runs (in DRY_RUN) without the dependency installed.
 */
async function loadSandcastle(): Promise<SandcastleModule> {
  try {
    return (await import(SANDCASTLE_PACKAGE)) as SandcastleModule;
  } catch (error) {
    throw new SandcastleNotIntegratedError(
      `cannot load ${SANDCASTLE_PACKAGE} (${(error as Error).message})`,
    );
  }
}

async function loadSandcastleDocker(): Promise<SandcastleDockerModule> {
  try {
    return (await import(SANDCASTLE_DOCKER_PACKAGE)) as SandcastleDockerModule;
  } catch (error) {
    throw new SandcastleNotIntegratedError(
      `cannot load ${SANDCASTLE_DOCKER_PACKAGE} (${(error as Error).message})`,
    );
  }
}
