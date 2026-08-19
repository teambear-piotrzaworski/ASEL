/**
 * ASEL orchestrator, main loop.
 *
 * Poll GitHub -> decide per issue (pure state machine) -> order the pending
 * runs and start what the limits allow (pure scheduler, see plan.ts) -> apply
 * the resulting labels, comment, notify.
 *
 * The scheduling rule that shapes everything else: one plan is one branch, so
 * at most one run per plan is active at a time and the tasks of a plan run in
 * slice order. No webhooks: the target VPS has no public ports.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type ProjectConfig } from "./config.js";
import { createGitExec, inspectRepoPath, syncRepo, type GitExec } from "./git-sync.js";
import { GitHubClient, type GitHubIssue } from "./github.js";
import { writeHeartbeat } from "./heartbeat.js";
import { ensureLabels } from "./labels.js";
import { createLogger, type Logger } from "./logger.js";
import {
  applyLabelUpdate,
  decide,
  describeRunKind,
  isAselIssue,
  isRunKind,
  labelUpdateAfterRun,
  labelsFor,
  type Gates,
  type RunKind,
  type RunOutcome,
} from "./machine.js";
import { createNotifier, shouldNotifyOutcome, type Notifier } from "./notify.js";
import {
  describeSkipReason,
  isTaskGateOpen,
  issueKeyFor,
  parseIssueMarkers,
  planContextFor,
  planKeyFor,
  scheduleRuns,
  type PlanContext,
  type SchedulableRun,
  type StalledTask,
} from "./plan.js";
import { applyStatusBlock, renderStatusBlock, stripStatusBlock } from "./status.js";
import { createRunners, type RunContext, type Runners } from "./runner/index.js";
import { StateStore } from "./state.js";

const log = createLogger("orchestrator");

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`missing required environment variable ${name}`);
  }
  return value;
}

/**
 * Working copy path for a project inside the repos directory. The clone that
 * lives here is created and refreshed by git-sync.ts before every run, and it
 * is what Sandcastle is handed as `cwd` to make its worktrees from.
 */
function repoPathFor(reposDir: string, project: ProjectConfig): string {
  return join(reposDir, `${project.owner}__${project.repoName}`);
}

/**
 * What a human is expected to do after a successful run. The three gates need
 * one; the runs that chain automatically only say where their work landed.
 *
 * The slicing run is the one that depends on the project: with the plan gate
 * switched off nobody is asked to read the plan, the task creation run starts
 * on the next poll, and saying otherwise would send a human to a gate that is
 * not there.
 */
function nextStepHint(
  kind: RunKind,
  prefix: string,
  branch: string,
  gates: Gates,
): string | null {
  const L = labelsFor(prefix);
  const orRework = `If it is not good enough, say why in a comment and set \`${L.rework}\` to have this step redone.`;
  switch (kind) {
    case "wayfinder":
      return `Comment on the decision tickets, then set \`${L.approved}\` to start the spec pipeline. ${orRework}`;
    case "prd":
      return `Read the ADRs and the PRD on \`${branch}\`, then set \`${L.toPlan}\` to have the plan sliced. ${orRework}`;
    case "slices":
      return gates.planApproval
        ? `Read the sliced plan on \`${branch}\`, then set \`${L.toTasks}\` to have the task issues created. ${orRework}`
        : `The plan gate is off for this project, so the task issues are created next without waiting. ${orRework}`;
    case "tasks":
      return `The tasks run one at a time, in slice order, on this same branch. ${orRework}`;
    case "implement":
      return `Review the commits on \`${branch}\` and close this issue when you are satisfied. Merging the branch is your call. ${orRework}`;
    default:
      return null;
  }
}

/** A run that passed the state machine and is waiting for a scheduling slot. */
interface PendingRun extends SchedulableRun {
  issue: GitHubIssue;
  trigger: string;
  /** True when the run repeats a step a human rejected with `asel:rework`. */
  isRework: boolean;
  plan: PlanContext;
}

interface RunnerOutcomeSummary {
  ok: boolean;
  /** The run finished cleanly but asked a human a question and stopped. */
  blocked?: boolean;
  summary: string;
  error?: string;
}

class Orchestrator {
  private readonly config = loadConfig(process.env["ASEL_CONFIG_DIR"] ?? process.cwd());
  private readonly github: GitHubClient;
  private readonly store: StateStore;
  private readonly notifier: Notifier;
  private readonly runners: Runners;
  private readonly stateDir: string;
  private readonly reposDir: string;
  private readonly dryRun: boolean;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly gitExec: GitExec = createGitExec();
  /** One chain of repository syncs per clone, see syncRepository(). */
  private readonly repoSyncs = new Map<string, Promise<void>>();
  private stopping = false;
  private wakeUp: (() => void) | null = null;

  constructor() {
    this.dryRun = process.env["DRY_RUN"] === "1";
    this.stateDir = process.env["ASEL_STATE_DIR"] ?? this.config.global.paths.state;
    this.reposDir = process.env["ASEL_REPOS_DIR"] ?? this.config.global.paths.repos;
    mkdirSync(this.stateDir, { recursive: true });
    mkdirSync(this.reposDir, { recursive: true });

    // GITHUB_API_URL exists so the loop can be pointed at a mock during tests.
    this.github = new GitHubClient(requireEnv("GITHUB_TOKEN"), process.env["GITHUB_API_URL"]);
    this.store = new StateStore(join(this.stateDir, "asel.sqlite"));
    this.notifier = createNotifier(this.config.global, log.child("notify"));
    this.runners = createRunners({
      dryRun: this.dryRun,
      labelPrefix: this.config.global.label_prefix,
    });
  }

  async start(): Promise<void> {
    const user = await this.github.whoami();
    log.info("orchestrator starting", {
      githubUser: user.login,
      projects: this.config.projects.length,
      dryRun: this.dryRun,
      pollIntervalSeconds: this.config.global.poll_interval_seconds,
      labelPrefix: this.config.global.label_prefix,
    });

    await this.bootstrapLabels();
    await this.reconcile();
    writeHeartbeat(this.stateDir);

    while (!this.stopping) {
      try {
        await this.tick();
      } catch (error) {
        log.error("poll cycle failed", { error: (error as Error).message });
      }
      writeHeartbeat(this.stateDir);
      await this.sleep(this.config.global.poll_interval_seconds * 1000);
    }

    await this.drain();
  }

  /**
   * Makes sure every repository in the registry carries the labels the state
   * machine drives itself with, with a description saying what each one does.
   * Runs once at startup, never fails the boot: a token without label rights is
   * a legitimate setup and only means the labels have to exist already.
   * `ASEL_BOOTSTRAP_LABELS=0` turns it off.
   */
  private async bootstrapLabels(): Promise<void> {
    if (process.env["ASEL_BOOTSTRAP_LABELS"] === "0") {
      log.info("label bootstrap disabled (ASEL_BOOTSTRAP_LABELS=0)");
      return;
    }
    const prefix = this.config.global.label_prefix;
    for (const project of this.config.projects) {
      try {
        const report = await ensureLabels(
          this.github,
          project.fullName,
          prefix,
          log.child("labels"),
        );
        log.info("labels ensured", {
          repo: project.fullName,
          created: report.created.length,
          updated: report.updated.length,
          failed: report.failed.length,
        });
      } catch (error) {
        log.warn("label bootstrap failed", {
          repo: project.fullName,
          error: (error as Error).message,
        });
      }
    }
  }

  /**
   * Startup reconciliation: runs still marked running belong to a process that
   * no longer exists. Mark them interrupted and say so on the issue. Their
   * trigger labels are untouched, so the next poll picks them up again.
   */
  private async reconcile(): Promise<void> {
    const interrupted = this.store.markInterruptedRuns();
    if (interrupted.length === 0) {
      log.info("reconciliation: no interrupted runs");
      return;
    }
    log.warn("reconciliation: interrupted runs found", { count: interrupted.length });
    for (const run of interrupted) {
      log.warn("run interrupted by restart", {
        repo: run.repo,
        issue: run.issue,
        kind: run.kind,
        startedAt: run.startedAt,
      });
      // A state file written by an older build can hold a retired kind.
      const description = isRunKind(run.kind) ? describeRunKind(run.kind) : `${run.kind} run`;
      try {
        await this.github.createComment(
          run.repo,
          run.issue,
          `ASEL: the ${description} started at ${run.startedAt} was interrupted by an orchestrator restart. It will be retried on the next poll because the trigger label is still set.`,
        );
      } catch (error) {
        log.warn("cannot comment on interrupted run", { error: (error as Error).message });
      }
    }
  }

  private async tick(): Promise<void> {
    for (const project of this.config.projects) {
      if (this.stopping) {
        return;
      }
      try {
        await this.pollProject(project);
      } catch (error) {
        log.error("project poll failed", {
          project: project.name,
          error: (error as Error).message,
        });
      }
    }
  }

  private async pollProject(project: ProjectConfig): Promise<void> {
    const prefix = this.config.global.label_prefix;
    const issues = await this.github.listOpenIssues(project.fullName);
    const managed = issues.filter((issue) => isAselIssue(issue.labels, prefix));
    log.debug("polled project", {
      project: project.name,
      openIssues: issues.length,
      managed: managed.length,
    });

    // Runs of this project that are in flight right now, so the status block
    // says "running" instead of flipping back to "queued" between two polls.
    const activeKinds = new Map<number, RunKind>();
    for (const run of this.store.activeRuns()) {
      if (run.repo === project.fullName && isRunKind(run.kind)) {
        activeKinds.set(run.issue, run.kind);
      }
    }

    // Open plan tasks stopped on `asel:failed` or `asel:blocked`. They trigger
    // no run themselves (decide idles on them), but scheduleRuns holds every
    // later slice of their plan back until a human resolves them.
    const L = labelsFor(prefix);
    const stalledTasks: StalledTask[] = [];
    for (const issue of managed) {
      const has = (label: string) => issue.labels.includes(label);
      if (!has(L.task) || (!has(L.failed) && !has(L.blocked))) {
        continue;
      }
      const markers = parseIssueMarkers(issue.body);
      if (markers.epicIssue === null) {
        continue;
      }
      stalledTasks.push({
        planKey: planKeyFor(project.fullName, markers.epicIssue),
        issueNumber: issue.number,
        slice: markers.slice,
      });
    }

    const pending: PendingRun[] = [];
    for (const issue of managed) {
      // Every managed issue gets its status block refreshed. Rendering is pure
      // and the write is skipped when the body would not change, so this costs
      // one string comparison per issue per cycle and covers both moments that
      // matter: the first time the orchestrator sees an issue, and any label a
      // human changed between two polls.
      await this.refreshStatus(project, issue, activeKinds.get(issue.number) ?? null);

      const decision = decide(
        { repo: project.fullName, number: issue.number, labels: issue.labels },
        prefix,
      );
      if (decision.action === "idle") {
        log.debug("issue idle", {
          repo: project.fullName,
          issue: issue.number,
          reason: decision.reason,
        });
        continue;
      }
      const plan = planContextFor({
        repo: project.fullName,
        issueNumber: issue.number,
        issueBody: issue.body,
        kind: decision.kind,
        role: decision.role,
      });
      pending.push({
        issue,
        trigger: decision.trigger,
        isRework: decision.isRework,
        plan,
        issueKey: issueKeyFor(project.fullName, issue.number),
        issueNumber: issue.number,
        planKey: plan.planKey,
        kind: decision.kind,
        role: decision.role,
        slice: plan.slice,
      });
    }
    if (pending.length === 0) {
      return;
    }

    // The scheduling rules are pure: this snapshot plus the limits decide
    // everything, so the ordering and the one run per plan rule are testable
    // without GitHub or SQLite.
    const decisions = scheduleRuns(
      pending,
      {
        activeTotal: this.store.activeRunCount(),
        activeInProject: this.store.activeRunCountForRepo(project.fullName),
        busyIssues: this.store
          .activeIssuesForRepo(project.fullName)
          .map((number) => issueKeyFor(project.fullName, number)),
        busyPlans: this.store.activePlanKeys(),
        stalledTasks,
      },
      {
        global: this.config.global.concurrency.global,
        project: project.concurrency,
        taskGateOpen: isTaskGateOpen(process.env["ASEL_TASK_GATE"]),
      },
    );

    for (const decision of decisions) {
      if (this.stopping) {
        return;
      }
      const pendingRun = decision.run;
      if (!decision.start) {
        log.debug("run waiting", {
          repo: project.fullName,
          issue: pendingRun.issueNumber,
          kind: pendingRun.kind,
          slice: pendingRun.slice,
          planKey: pendingRun.planKey,
          reason:
            decision.reason === undefined ? "unknown" : describeSkipReason(decision.reason),
        });
        continue;
      }

      // The pending list was built from an issue list that is seconds old by
      // now, and a run finishing inside that window rewrites the labels its
      // decision was made from - starting from the stale ones is what once
      // re-ran a completed task. So the decision is retaken on labels fetched
      // right now, and only an unchanged decision starts the run.
      try {
        const fresh = await this.github.getIssue(project.fullName, pendingRun.issueNumber);
        const recheck = decide(
          { repo: project.fullName, number: fresh.number, labels: fresh.labels },
          prefix,
        );
        if (
          recheck.action !== "start" ||
          recheck.kind !== pendingRun.kind ||
          recheck.trigger !== pendingRun.trigger ||
          recheck.isRework !== pendingRun.isRework
        ) {
          log.info("issue changed since the poll, run not started", {
            repo: project.fullName,
            issue: pendingRun.issueNumber,
            wasTrigger: pendingRun.trigger,
            now: recheck.action === "idle" ? recheck.reason : `trigger ${recheck.trigger}`,
          });
          continue;
        }
      } catch (error) {
        log.warn("cannot recheck the issue, run deferred to the next poll", {
          repo: project.fullName,
          issue: pendingRun.issueNumber,
          error: (error as Error).message,
        });
        continue;
      }

      const runId = this.store.startRun(
        project.fullName,
        pendingRun.issueNumber,
        pendingRun.kind,
        pendingRun.trigger,
        pendingRun.planKey,
      );
      if (runId === null) {
        // Lost the race against another run for the same issue or the same plan.
        log.debug("run rejected by the state store", {
          repo: project.fullName,
          issue: pendingRun.issueNumber,
          planKey: pendingRun.planKey,
        });
        continue;
      }

      const promise = this.executeRun(runId, project, pendingRun)
        .catch((error: unknown) => {
          log.error("run supervisor failed", { error: (error as Error).message });
        })
        .finally(() => {
          this.inFlight.delete(promise);
        });
      this.inFlight.add(promise);
    }
  }

  /**
   * Rewrites the status block inside the issue body, if it would change.
   *
   * Everything it renders comes from data the orchestrator already has: the
   * labels of the polled issue, the markers in its body and the run state from
   * SQLite. No extra GitHub read. The write is skipped when the body is
   * identical, which is what makes calling this on every poll cheap.
   *
   * The in memory copy of the body is updated too, so later renders in the same
   * cycle compare against what is now on GitHub.
   */
  private async refreshStatus(
    project: ProjectConfig,
    issue: GitHubIssue,
    activeRunKind: RunKind | null,
    labels: readonly string[] = issue.labels,
  ): Promise<void> {
    const block = renderStatusBlock({
      labelPrefix: this.config.global.label_prefix,
      issueNumber: issue.number,
      issueUrl: issue.htmlUrl,
      labels,
      markers: parseIssueMarkers(issue.body),
      activeRunKind,
    });

    try {
      issue.body = await applyStatusBlock(issue.body, block, async (nextBody) => {
        await this.github.updateIssueBody(project.fullName, issue.number, nextBody);
        log.debug("status block updated", { repo: project.fullName, issue: issue.number });
      });
    } catch (error) {
      // A read only token, or an issue locked by a human: worth a warning, never
      // worth failing a run over.
      log.warn("cannot update the status block", {
        repo: project.fullName,
        issue: issue.number,
        error: (error as Error).message,
      });
    }
  }

  private async executeRun(
    runId: number,
    project: ProjectConfig,
    pending: PendingRun,
  ): Promise<void> {
    const prefix = this.config.global.label_prefix;
    const { issue, kind, role, trigger, isRework, plan } = pending;
    // The agent gets the issue as a human wrote it: the status block is
    // orchestrator bookkeeping, not part of the request.
    const context: RunContext = {
      project,
      repo: project.fullName,
      issue: {
        number: issue.number,
        title: issue.title,
        body: stripStatusBlock(issue.body),
        htmlUrl: issue.htmlUrl,
      },
      role,
      triggerLabel: trigger,
      isRework,
      repoPath: repoPathFor(this.reposDir, project),
      branch: plan.branch,
      epicIssue: plan.epicIssue,
      slice: plan.slice,
      log: log.child(`${project.name}#${issue.number}`),
    };

    log.info("run started", {
      runId,
      repo: context.repo,
      issue: issue.number,
      kind,
      role,
      trigger,
      isRework,
      branch: context.branch,
      planKey: plan.planKey,
      slice: plan.slice,
    });

    // Tell the issue a run is working on it, before the run takes minutes.
    await this.refreshStatus(project, issue, kind);

    let outcome: RunnerOutcomeSummary;
    try {
      // Nothing starts on a clone that does not exist or is behind origin: the
      // plan branch is continued run after run, so the previous run's commits
      // have to be here before this one gets a worktree. A failure here fails
      // THIS run (label, comment, push) and nothing else.
      await this.syncRepository(project, context.repoPath, context.log);
      outcome = await this.dispatch(kind, context);
    } catch (error) {
      outcome = {
        ok: false,
        summary: `${describeRunKind(kind)} failed`,
        error: (error as Error).message,
      };
    }

    // Three outcomes, not two: a blocked run did its job and stopped on a
    // question, so it must neither advance the pipeline nor be recorded as a
    // failure a human has to debug.
    const runOutcome: RunOutcome =
      outcome.blocked === true ? "blocked" : outcome.ok ? "success" : "failure";

    const update = labelUpdateAfterRun(kind, runOutcome, prefix, {
      role,
      isRework,
      gates: project.gates,
    });
    try {
      for (const label of update.remove) {
        await this.github.removeLabel(context.repo, issue.number, label);
      }
      await this.github.addLabels(context.repo, issue.number, update.add);
    } catch (error) {
      log.error("cannot apply labels", {
        repo: context.repo,
        issue: issue.number,
        error: (error as Error).message,
      });
    }

    // Only now is the run over as far as the scheduler is concerned. Finishing
    // it in the store frees the plan, and a poll running concurrently would
    // start the next run against whatever labels the issue carried mid-update:
    // that exact race once re-ran a completed task, because the poll caught the
    // issue after `rework` was removed and before `in-review` was added.
    this.store.finishRun(
      runId,
      runOutcome === "success" ? "succeeded" : runOutcome === "blocked" ? "blocked" : "failed",
      {
        ...(outcome.error === undefined ? {} : { error: outcome.error }),
        result: { summary: outcome.summary },
      },
    );

    // New stage, new status block. The label set is computed locally, so this
    // costs no extra GitHub read.
    await this.refreshStatus(project, issue, null, applyLabelUpdate(issue.labels, update));

    // The spec pipeline runs drop their own trigger label on failure, so a
    // retry means setting that label again. The implement run keeps it, so
    // there a retry means removing the failed label.
    const retryHint = update.remove.includes(trigger)
      ? `Set the \`${trigger}\` label again to retry.`
      : `Remove the \`${prefix}:failed\` label to retry.`;
    const nextStep = nextStepHint(kind, prefix, context.branch, project.gates);
    const commentBody =
      runOutcome === "blocked"
        ? `ASEL: ${describeRunKind(kind)} stopped and asked a question.\n\n${outcome.summary}\n\n` +
          `Answer it in a comment, then set the \`${labelsFor(prefix).rework}\` label to have this step repeated with your answer.`
        : runOutcome === "success"
          ? `ASEL: ${describeRunKind(kind)} finished.\n\n${outcome.summary}${nextStep === null ? "" : `\n\n${nextStep}`}`
          : `ASEL: ${describeRunKind(kind)} failed.\n\n\`\`\`\n${outcome.error ?? "unknown error"}\n\`\`\`\n\n${retryHint}`;
    try {
      await this.github.createComment(context.repo, issue.number, commentBody);
    } catch (error) {
      log.warn("cannot comment on issue", { error: (error as Error).message });
    }

    // One push rule for the whole orchestrator, see notify.ts: an alarm only
    // when the process is stuck on a human.
    if (shouldNotifyOutcome(runOutcome)) {
      const label = `${context.repo}#${issue.number}`;
      await this.notifier.notify({
        title: runOutcome === "blocked" ? "ASEL: question waiting" : "ASEL: run failed",
        message:
          runOutcome === "blocked"
            ? `${label}: the ${describeRunKind(kind)} needs an answer before it can continue`
            : `${label}: the ${describeRunKind(kind)} failed, ${outcome.error ?? "unknown error"}`,
        url: issue.htmlUrl,
      });
    }

    log.info("run finished", {
      runId,
      repo: context.repo,
      issue: issue.number,
      kind,
      outcome: runOutcome,
      summary: outcome.summary,
    });
  }

  /**
   * Makes sure the project's clone exists and its refs are current, before any
   * run is handed a path to it.
   *
   * Serialized per clone. The per project concurrency limit is usually 1, but a
   * project may raise it, and two `git clone` calls into the same directory
   * race in a way that leaves half a repository behind. Chaining costs nothing
   * once the clone is there: the second run waits out one fetch.
   *
   * DRY_RUN does not clone. That mode exists to exercise the state machine
   * without side effects, and pulling every project repository onto the disk is
   * the largest side effect the orchestrator has.
   */
  private async syncRepository(
    project: ProjectConfig,
    repoPath: string,
    runLog: Logger,
  ): Promise<void> {
    if (this.dryRun) {
      runLog.info("repository sync skipped (DRY_RUN)", { path: repoPath });
      return;
    }
    const previous = this.repoSyncs.get(repoPath) ?? Promise.resolve();
    const sync = async (): Promise<void> => {
      const action = await syncRepo(
        {
          owner: project.owner,
          repoName: project.repoName,
          repoPath,
          token: process.env["GITHUB_TOKEN"],
        },
        { inspect: inspectRepoPath, exec: this.gitExec, log: runLog.child("git") },
      );
      runLog.debug("repository ready", { path: repoPath, action });
    };
    // Runs after the previous sync of this clone whether it worked or not: a
    // failed clone must not stop the next run from trying again.
    const next = previous.then(sync, sync);
    // What is stored is the settled form, so a failure never surfaces as an
    // unhandled rejection through the chain. The caller below still sees it.
    this.repoSyncs.set(
      repoPath,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    await next;
  }

  /**
   * Runs one kind and normalizes its result. No notification is built here on
   * purpose: whether a push goes out depends on how the run ENDED, not on which
   * kind it was, and that decision lives in one place (notify.ts).
   */
  private async dispatch(kind: RunKind, context: RunContext): Promise<RunnerOutcomeSummary> {
    const runner = this.runners;
    const result = await (kind === "wayfinder"
      ? runner.wayfinder.runWayfinder(context)
      : kind === "adr"
        ? runner.adr.runAdr(context)
        : kind === "prd"
          ? runner.prd.runPrd(context)
          : kind === "slices"
            ? runner.slices.runSlices(context)
            : kind === "tasks"
              ? runner.tasks.runTasks(context)
              : runner.implement.runImplement(context));

    return {
      ok: result.ok,
      ...(result.blocked === true ? { blocked: true } : {}),
      summary: result.summary,
      ...(result.error === undefined ? {} : { error: result.error }),
    };
  }

  /** Interruptible sleep, so SIGTERM does not have to wait out the interval. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wakeUp = null;
        resolve();
      }, ms);
      this.wakeUp = () => {
        clearTimeout(timer);
        this.wakeUp = null;
        resolve();
      };
    });
  }

  private async drain(): Promise<void> {
    if (this.inFlight.size > 0) {
      log.info("waiting for in flight runs", { count: this.inFlight.size });
      const timeoutMs = Number(process.env["ASEL_SHUTDOWN_TIMEOUT_MS"] ?? "60000");
      await Promise.race([
        Promise.allSettled([...this.inFlight]),
        new Promise((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
    this.store.close();
    log.info("orchestrator stopped");
  }

  stop(signal: string): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    log.info("shutdown requested", { signal });
    this.wakeUp?.();
  }
}

async function main(): Promise<void> {
  const orchestrator = new Orchestrator();
  process.on("SIGTERM", () => orchestrator.stop("SIGTERM"));
  process.on("SIGINT", () => orchestrator.stop("SIGINT"));
  await orchestrator.start();
}

main().catch((error: unknown) => {
  log.error("fatal", { error: (error as Error).message });
  process.exitCode = 1;
});
