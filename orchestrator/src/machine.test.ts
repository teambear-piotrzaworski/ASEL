import { describe, expect, it } from "vitest";
import {
  RUN_KINDS,
  allLabels,
  applyLabelUpdate,
  decide,
  describeRunKind,
  isAselIssue,
  isRunKind,
  labelUpdateAfterRun,
  labelsFor,
  roleOf,
  sliceLabelFor,
  sliceLabelPrefix,
  type IssueSnapshot,
  type RunKind,
} from "./machine.js";

const PREFIX = "asel";
const L = labelsFor(PREFIX);

const ALL_KINDS = RUN_KINDS;

function issue(labels: string[]): IssueSnapshot {
  return { repo: "acme/example", number: 1, labels };
}

describe("labelsFor", () => {
  it("builds every label from the configured prefix", () => {
    const custom = labelsFor("factory");
    expect(custom.plan).toBe("factory:plan");
    expect(custom.toPrd).toBe("factory:to-prd");
    expect(custom.specToApprove).toBe("factory:spec-to-approve");
    expect(custom.toPlan).toBe("factory:to-plan");
    expect(custom.planToApprove).toBe("factory:plan-to-approve");
    expect(custom.toTasks).toBe("factory:to-tasks");
    expect(custom.inReview).toBe("factory:in-review");
    expect(custom.blocked).toBe("factory:blocked");
    expect(allLabels("factory")).toHaveLength(15);
  });

  it("keeps every label unique", () => {
    expect(new Set(allLabels(PREFIX)).size).toBe(allLabels(PREFIX).length);
  });
});

describe("slice marker labels", () => {
  it("derives the human readable slice label from the configured prefix", () => {
    expect(sliceLabelPrefix("factory")).toBe("factory:slice-");
    expect(sliceLabelFor(PREFIX, 3)).toBe("asel:slice-3");
  });

  it("stays out of the state machine label set", () => {
    expect(allLabels(PREFIX)).not.toContain(sliceLabelFor(PREFIX, 1));
  });
});

describe("isAselIssue", () => {
  it("recognizes issues carrying an owned label", () => {
    expect(isAselIssue([L.plan], PREFIX)).toBe(true);
    expect(isAselIssue(["bug", L.task], PREFIX)).toBe(true);
    expect(isAselIssue([L.specToApprove], PREFIX)).toBe(true);
  });

  it("ignores unrelated issues", () => {
    expect(isAselIssue(["bug", "wayfinder:map"], PREFIX)).toBe(false);
    expect(isAselIssue([], PREFIX)).toBe(false);
  });
});

describe("roleOf", () => {
  it("treats issues with the task label as tasks", () => {
    expect(roleOf([L.task], PREFIX)).toBe("task");
    expect(roleOf([L.plan], PREFIX)).toBe("epic");
  });
});

describe("decide: wayfinder stage", () => {
  it("starts a wayfinder run on asel:plan", () => {
    expect(decide(issue([L.plan]), PREFIX)).toEqual({
      action: "start",
      kind: "wayfinder",
      role: "epic",
      trigger: L.plan,
      isRework: false,
    });
  });

  it("waits for a human once planned", () => {
    const decision = decide(issue([L.planned]), PREFIX);
    expect(decision.action).toBe("idle");
  });
});

describe("decide: rework", () => {
  it("repeats the wayfinder run at the decision gate", () => {
    expect(decide(issue([L.planned, L.rework]), PREFIX)).toEqual({
      action: "start",
      kind: "wayfinder",
      role: "epic",
      trigger: L.rework,
      isRework: true,
    });
  });

  it("repeats the prd run at the spec gate", () => {
    expect(decide(issue([L.specToApprove, L.rework]), PREFIX)).toMatchObject({
      kind: "prd",
      role: "epic",
      trigger: L.rework,
      isRework: true,
    });
  });

  it("repeats the slices run at the plan gate", () => {
    expect(decide(issue([L.planToApprove, L.rework]), PREFIX)).toMatchObject({
      kind: "slices",
      isRework: true,
    });
  });

  it("repeats the tasks run once specced", () => {
    expect(decide(issue([L.specced, L.rework]), PREFIX)).toMatchObject({
      kind: "tasks",
      isRework: true,
    });
  });

  it("repeats the implementation of a task in review", () => {
    expect(decide(issue([L.task, L.inReview, L.rework]), PREFIX)).toEqual({
      action: "start",
      kind: "implement",
      role: "task",
      trigger: L.rework,
      isRework: true,
    });
  });

  it("repeats the implementation of a fast issue in review", () => {
    expect(decide(issue([L.fast, L.inReview, L.rework]), PREFIX)).toEqual({
      action: "start",
      kind: "implement",
      role: "epic",
      trigger: L.rework,
      isRework: true,
    });
  });

  it("idles when nothing next to it says which step to repeat", () => {
    const decision = decide(issue([L.rework]), PREFIX);
    expect(decision.action).toBe("idle");
    expect(decision).toMatchObject({ reason: expect.stringContaining(L.rework) });
    expect(decide(issue([L.toPrd, L.rework]), PREFIX).action).toBe("idle");
    expect(decide(issue([L.task, L.rework]), PREFIX).action).toBe("idle");
  });

  it("repeats the implementation of a blocked task or fast issue", () => {
    expect(decide(issue([L.task, L.blocked, L.rework]), PREFIX)).toEqual({
      action: "start",
      kind: "implement",
      role: "task",
      trigger: L.rework,
      isRework: true,
    });
    expect(decide(issue([L.fast, L.blocked, L.rework]), PREFIX)).toMatchObject({
      kind: "implement",
      role: "epic",
      isRework: true,
    });
  });

  it("lets the state label next to blocked pick the run, not the blocked label", () => {
    expect(decide(issue([L.specToApprove, L.blocked, L.rework]), PREFIX)).toMatchObject({
      kind: "prd",
    });
    expect(decide(issue([L.planToApprove, L.blocked, L.rework]), PREFIX)).toMatchObject({
      kind: "slices",
    });
    expect(decide(issue([L.specced, L.blocked, L.rework]), PREFIX)).toMatchObject({
      kind: "tasks",
    });
    expect(decide(issue([L.planned, L.blocked, L.rework]), PREFIX)).toMatchObject({
      kind: "wayfinder",
    });
  });

  it("reads a bare blocked label as the implementation stage only for a task or a fast issue", () => {
    // Those two labels are identity, not triggers: an implementation run keeps
    // them however it ends, so the issue really is in the implementation stage.
    expect(decide(issue([L.task, L.blocked, L.rework]), PREFIX)).toMatchObject({
      action: "start",
      kind: "implement",
      role: "task",
    });
    expect(decide(issue([L.fast, L.blocked, L.rework]), PREFIX)).toMatchObject({
      action: "start",
      kind: "implement",
      role: "epic",
    });
  });

  it("idles instead of implementing an epic that blocked in a pipeline run", () => {
    // An epic blocked in the wayfinder or prd run drops its trigger label and
    // has no gate label left, so there is nothing that names a stage. Reading
    // that as "implement" would point an implementation agent at a planning
    // issue, which is why it idles with a reason a human can act on.
    const decision = decide(issue([L.blocked, L.rework]), PREFIX);
    expect(decision.action).toBe("idle");
    expect(decision).toMatchObject({ reason: expect.stringContaining(L.blocked) });
    expect(decision).toMatchObject({ reason: expect.stringContaining(L.planned) });

    expect(decide(issue([L.inReview, L.blocked, L.rework]), PREFIX).action).toBe("idle");
  });

  it("beats the idle states, in-review included", () => {
    expect(decide(issue([L.task, L.inReview]), PREFIX).action).toBe("idle");
    expect(decide(issue([L.task, L.inReview, L.rework]), PREFIX).action).toBe("start");
  });

  it("beats a trigger set at the same time, because a correction comes first", () => {
    expect(decide(issue([L.specToApprove, L.toPlan, L.rework]), PREFIX)).toMatchObject({
      kind: "prd",
      isRework: true,
    });
    expect(decide(issue([L.planned, L.approved, L.rework]), PREFIX)).toMatchObject({
      kind: "wayfinder",
      isRework: true,
    });
    expect(decide(issue([L.planToApprove, L.toTasks, L.rework]), PREFIX)).toMatchObject({
      kind: "slices",
      isRework: true,
    });
  });

  it("runs even when the previous attempt failed", () => {
    expect(decide(issue([L.specToApprove, L.failed, L.rework]), PREFIX)).toMatchObject({
      kind: "prd",
      isRework: true,
    });
    expect(decide(issue([L.task, L.inReview, L.failed, L.rework]), PREFIX)).toMatchObject({
      kind: "implement",
      isRework: true,
    });
  });

  it("prefers the most advanced gate when two state labels linger", () => {
    expect(decide(issue([L.planned, L.specToApprove, L.rework]), PREFIX)).toMatchObject({
      kind: "prd",
    });
    expect(decide(issue([L.specToApprove, L.planToApprove, L.rework]), PREFIX)).toMatchObject({
      kind: "slices",
    });
    expect(decide(issue([L.planToApprove, L.specced, L.rework]), PREFIX)).toMatchObject({
      kind: "tasks",
    });
  });
});

describe("decide: spec pipeline", () => {
  it("starts an adr run on asel:approved", () => {
    expect(decide(issue([L.planned, L.approved]), PREFIX)).toEqual({
      action: "start",
      kind: "adr",
      role: "epic",
      trigger: L.approved,
      isRework: false,
    });
  });

  it("starts a prd run on asel:to-prd", () => {
    expect(decide(issue([L.toPrd]), PREFIX)).toEqual({
      action: "start",
      kind: "prd",
      role: "epic",
      trigger: L.toPrd,
      isRework: false,
    });
  });

  it("idles on the spec review gate", () => {
    expect(decide(issue([L.specToApprove]), PREFIX)).toMatchObject({ action: "idle" });
  });

  it("starts a slices run on asel:to-plan", () => {
    expect(decide(issue([L.specToApprove, L.toPlan]), PREFIX)).toEqual({
      action: "start",
      kind: "slices",
      role: "epic",
      trigger: L.toPlan,
      isRework: false,
    });
  });

  it("idles on the plan review gate", () => {
    expect(decide(issue([L.planToApprove]), PREFIX)).toMatchObject({ action: "idle" });
  });

  it("starts a tasks run on asel:to-tasks", () => {
    expect(decide(issue([L.toTasks]), PREFIX)).toEqual({
      action: "start",
      kind: "tasks",
      role: "epic",
      trigger: L.toTasks,
      isRework: false,
    });
  });

  it("starts a tasks run when a human sets to-tasks on the plan gate", () => {
    expect(decide(issue([L.planToApprove, L.toTasks]), PREFIX)).toEqual({
      action: "start",
      kind: "tasks",
      role: "epic",
      trigger: L.toTasks,
      isRework: false,
    });
  });

  it("idles once specced, because the tasks live on their own from there", () => {
    expect(decide(issue([L.specced]), PREFIX)).toMatchObject({ action: "idle" });
  });
});

describe("decide: trigger priority", () => {
  it("prefers the most advanced stage over an older trigger", () => {
    expect(decide(issue([L.plan, L.approved]), PREFIX)).toMatchObject({ kind: "adr" });
    expect(decide(issue([L.approved, L.toPrd]), PREFIX)).toMatchObject({ kind: "prd" });
    expect(decide(issue([L.toPrd, L.toPlan]), PREFIX)).toMatchObject({ kind: "slices" });
    expect(decide(issue([L.toPlan, L.toTasks]), PREFIX)).toMatchObject({ kind: "tasks" });
  });

  it("lets rework win over every trigger, whatever the stage", () => {
    expect(decide(issue([L.planned, L.plan, L.rework]), PREFIX)).toMatchObject({
      trigger: L.rework,
      isRework: true,
    });
    expect(decide(issue([L.fast, L.inReview, L.rework]), PREFIX)).toMatchObject({
      trigger: L.rework,
      isRework: true,
    });
  });

  it("lets the task label win over every epic trigger", () => {
    expect(decide(issue([L.task, L.toTasks]), PREFIX)).toEqual({
      action: "start",
      kind: "implement",
      role: "task",
      trigger: L.task,
      isRework: false,
    });
  });

  it("lets the fast shortcut win over everything, task label included", () => {
    expect(decide(issue([L.fast, L.task, L.toTasks]), PREFIX)).toEqual({
      action: "start",
      kind: "implement",
      role: "epic",
      trigger: L.fast,
      isRework: false,
    });
  });
});

describe("decide: implementation stage", () => {
  it("implements task issues", () => {
    expect(decide(issue([L.task]), PREFIX)).toEqual({
      action: "start",
      kind: "implement",
      role: "task",
      trigger: L.task,
      isRework: false,
    });
  });

  it("skips the whole pipeline on asel:fast", () => {
    expect(decide(issue([L.fast]), PREFIX)).toEqual({
      action: "start",
      kind: "implement",
      role: "epic",
      trigger: L.fast,
      isRework: false,
    });
  });

  it("lets the fast shortcut win over planning labels", () => {
    const decision = decide(issue([L.plan, L.fast]), PREFIX);
    expect(decision).toMatchObject({ action: "start", kind: "implement", role: "epic" });
  });

  it("stops once the commits are in review", () => {
    expect(decide(issue([L.task, L.inReview]), PREFIX).action).toBe("idle");
    expect(decide(issue([L.fast, L.inReview]), PREFIX).action).toBe("idle");
  });
});

describe("decide: blocked", () => {
  it("idles on a blocked issue of any shape, because only a human moves it", () => {
    for (const labels of [
      [L.blocked],
      [L.task, L.blocked],
      [L.fast, L.blocked],
      [L.planned, L.blocked],
      [L.specToApprove, L.blocked],
      [L.planToApprove, L.blocked],
      [L.specced, L.blocked],
    ]) {
      expect(decide(issue(labels), PREFIX).action, labels.join("+")).toBe("idle");
    }
  });

  it("says what unblocks it", () => {
    expect(decide(issue([L.blocked]), PREFIX)).toMatchObject({
      reason: expect.stringContaining(L.rework),
    });
  });

  it("lets a trigger a human sets again win over it, exactly like over a failure", () => {
    expect(decide(issue([L.blocked, L.toPrd]), PREFIX)).toMatchObject({ kind: "prd" });
    expect(decide(issue([L.blocked, L.toTasks]), PREFIX)).toMatchObject({ kind: "tasks" });
  });
});

describe("decide: failures", () => {
  it("waits for a human on a failed task", () => {
    expect(decide(issue([L.task, L.failed]), PREFIX).action).toBe("idle");
  });

  it("waits for a human on a failed fast issue", () => {
    expect(decide(issue([L.fast, L.failed]), PREFIX).action).toBe("idle");
  });

  it("waits for a human on a failed epic with no trigger left", () => {
    expect(decide(issue([L.failed]), PREFIX)).toMatchObject({ action: "idle" });
    expect(decide(issue([L.planned, L.failed]), PREFIX)).toMatchObject({ action: "idle" });
  });

  it("retries every stage when a human sets its trigger label again", () => {
    expect(decide(issue([L.failed, L.plan]), PREFIX)).toMatchObject({ kind: "wayfinder" });
    expect(decide(issue([L.failed, L.approved]), PREFIX)).toMatchObject({ kind: "adr" });
    expect(decide(issue([L.failed, L.toPrd]), PREFIX)).toMatchObject({ kind: "prd" });
    expect(decide(issue([L.failed, L.toPlan]), PREFIX)).toMatchObject({ kind: "slices" });
    expect(decide(issue([L.failed, L.toTasks]), PREFIX)).toMatchObject({ kind: "tasks" });
  });

  it("stays idle without any trigger", () => {
    expect(decide(issue([]), PREFIX)).toEqual({ action: "idle", reason: "no trigger label" });
  });
});

describe("labelUpdateAfterRun: success", () => {
  it("moves plan to planned", () => {
    expect(labelUpdateAfterRun("wayfinder", "success", PREFIX)).toEqual({
      add: [L.planned],
      remove: [L.plan, L.failed, L.blocked],
    });
  });

  it("moves approved to to-prd", () => {
    expect(labelUpdateAfterRun("adr", "success", PREFIX)).toEqual({
      add: [L.toPrd],
      remove: [L.approved, L.planned, L.failed, L.blocked],
    });
  });

  it("moves to-prd to the spec review gate", () => {
    expect(labelUpdateAfterRun("prd", "success", PREFIX)).toEqual({
      add: [L.specToApprove],
      remove: [L.toPrd, L.failed, L.blocked],
    });
  });

  it("moves to-plan to the plan review gate and clears the spec gate", () => {
    expect(labelUpdateAfterRun("slices", "success", PREFIX)).toEqual({
      add: [L.planToApprove],
      remove: [L.toPlan, L.specToApprove, L.failed, L.blocked],
    });
  });

  it("moves to-tasks to specced and clears the plan gate", () => {
    expect(labelUpdateAfterRun("tasks", "success", PREFIX)).toEqual({
      add: [L.specced],
      remove: [L.toTasks, L.planToApprove, L.failed, L.blocked],
    });
  });

  it("moves an implemented task to in-review and keeps the task label", () => {
    const update = labelUpdateAfterRun("implement", "success", PREFIX, { role: "task" });
    expect(update.add).toEqual([L.inReview]);
    expect(update.remove).not.toContain(L.task);
  });

  it("clears the fast label when a fast run succeeds", () => {
    expect(labelUpdateAfterRun("implement", "success", PREFIX, { role: "epic" })).toEqual({
      add: [L.inReview],
      remove: [L.fast, L.failed, L.blocked],
    });
  });

  it("clears both stop labels on every successful run", () => {
    for (const kind of ALL_KINDS) {
      expect(labelUpdateAfterRun(kind, "success", PREFIX).remove).toContain(L.failed);
      expect(labelUpdateAfterRun(kind, "success", PREFIX).remove).toContain(L.blocked);
    }
  });
});

describe("labelUpdateAfterRun: the plan approval gate", () => {
  it("keeps the gate by default and when it is explicitly on", () => {
    expect(labelUpdateAfterRun("slices", "success", PREFIX).add).toEqual([L.planToApprove]);
    expect(
      labelUpdateAfterRun("slices", "success", PREFIX, { gates: { planApproval: true } }).add,
    ).toEqual([L.planToApprove]);
  });

  it("chains straight into the tasks run when the gate is off", () => {
    expect(
      labelUpdateAfterRun("slices", "success", PREFIX, { gates: { planApproval: false } }),
    ).toEqual({
      add: [L.toTasks],
      remove: [L.toPlan, L.specToApprove, L.failed, L.blocked],
    });
  });

  it("changes nothing about the other kinds or about a failure", () => {
    const gates = { planApproval: false };
    expect(labelUpdateAfterRun("slices", "failure", PREFIX, { gates })).toEqual({
      add: [L.failed],
      remove: [L.toPlan, L.blocked],
    });
    expect(labelUpdateAfterRun("prd", "success", PREFIX, { gates }).add).toEqual([
      L.specToApprove,
    ]);
    expect(labelUpdateAfterRun("tasks", "success", PREFIX, { gates }).add).toEqual([L.specced]);
  });

  it("walks the epic from the slicing run to specced without a human", () => {
    let labels = [L.specToApprove, L.toPlan];
    labels = applyUpdate(
      labels,
      labelUpdateAfterRun("slices", "success", PREFIX, { gates: { planApproval: false } }),
    );
    expect(labels).toEqual([L.toTasks]);

    // No gate label in between, so the very next poll starts the tasks run.
    expect(decide(issue(labels), PREFIX)).toMatchObject({ action: "start", kind: "tasks" });
    labels = applyUpdate(labels, labelUpdateAfterRun("tasks", "success", PREFIX));
    expect(labels).toEqual([L.specced]);
  });

  it("still lets a human redo the plan by hand, with no extra label", () => {
    // The gate is off, so there is no plan-to-approve label to hang rework on:
    // setting the trigger again is the documented way back.
    const labels = applyUpdate(
      [L.toTasks],
      labelUpdateAfterRun("tasks", "success", PREFIX, { gates: { planApproval: false } }),
    );
    expect(decide(issue([...labels, L.toPlan]), PREFIX)).toMatchObject({ kind: "slices" });
  });
});

describe("labelUpdateAfterRun: failure", () => {
  it("marks a failed wayfinder run", () => {
    expect(labelUpdateAfterRun("wayfinder", "failure", PREFIX)).toEqual({
      add: [L.failed],
      remove: [L.plan, L.blocked],
    });
  });

  it("marks a failed adr run and drops its trigger", () => {
    expect(labelUpdateAfterRun("adr", "failure", PREFIX)).toEqual({
      add: [L.failed],
      remove: [L.approved, L.blocked],
    });
  });

  it("marks a failed prd run and drops its trigger", () => {
    expect(labelUpdateAfterRun("prd", "failure", PREFIX)).toEqual({
      add: [L.failed],
      remove: [L.toPrd, L.blocked],
    });
  });

  it("marks a failed slices run and drops its trigger, keeping the gate label", () => {
    expect(labelUpdateAfterRun("slices", "failure", PREFIX)).toEqual({
      add: [L.failed],
      remove: [L.toPlan, L.blocked],
    });
  });

  it("marks a failed tasks run and drops its trigger", () => {
    expect(labelUpdateAfterRun("tasks", "failure", PREFIX)).toEqual({
      add: [L.failed],
      remove: [L.toTasks, L.blocked],
    });
  });

  it("keeps the trigger label on a failed implementation so removing failed retries it", () => {
    expect(labelUpdateAfterRun("implement", "failure", PREFIX, { role: "task" })).toEqual({
      add: [L.failed],
      remove: [L.blocked],
    });
    expect(labelUpdateAfterRun("implement", "failure", PREFIX, { role: "epic" })).toEqual({
      add: [L.failed],
      remove: [L.blocked],
    });
  });

  it("marks every kind as failed, and never as blocked at the same time", () => {
    for (const kind of ALL_KINDS) {
      const update = labelUpdateAfterRun(kind, "failure", PREFIX);
      expect(update.add).toEqual([L.failed]);
      expect(update.remove).toContain(L.blocked);
    }
  });

  it("uses the configured prefix everywhere", () => {
    expect(labelUpdateAfterRun("adr", "success", "factory")).toEqual({
      add: ["factory:to-prd"],
      remove: ["factory:approved", "factory:planned", "factory:failed", "factory:blocked"],
    });
  });
});

describe("labelUpdateAfterRun: blocked", () => {
  it("drops the same trigger label a failure would, kind by kind", () => {
    const dropped = (kind: RunKind): string[] =>
      labelUpdateAfterRun(kind, "blocked", PREFIX).remove.filter((label) => label !== L.failed);
    for (const kind of ALL_KINDS) {
      expect(dropped(kind), kind).toEqual(
        labelUpdateAfterRun(kind, "failure", PREFIX).remove.filter(
          (label) => label !== L.blocked,
        ),
      );
    }
  });

  it("hangs blocked instead of failed, and never both", () => {
    for (const kind of ALL_KINDS) {
      const update = labelUpdateAfterRun(kind, "blocked", PREFIX);
      expect(update.add).toEqual([L.blocked]);
      expect(update.remove).toContain(L.failed);
    }
  });

  it("keeps the trigger of an implementation run, exactly like a failure does", () => {
    expect(labelUpdateAfterRun("implement", "blocked", PREFIX, { role: "task" })).toEqual({
      add: [L.blocked],
      remove: [L.failed],
    });
  });

  it("clears rework when a rework run blocks, so it can be hung again", () => {
    expect(labelUpdateAfterRun("slices", "blocked", PREFIX, { isRework: true })).toEqual({
      add: [L.blocked],
      remove: [L.rework, L.failed],
    });
  });

  it("leaves the state label in place, and that label still names the run to repeat", () => {
    const labels = applyUpdate(
      [L.specToApprove, L.toPlan],
      labelUpdateAfterRun("slices", "blocked", PREFIX),
    );
    expect(labels).toEqual([L.specToApprove, L.blocked]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");
    // The neighbouring state label decides, exactly like it does after a
    // failure: `spec-to-approve` maps to the prd run, blocked or not.
    expect(decide(issue([...labels, L.rework]), PREFIX)).toMatchObject({
      kind: "prd",
      isRework: true,
    });
  });

  it("sends a blocked task back into its own implementation run", () => {
    const labels = applyUpdate([L.task], labelUpdateAfterRun("implement", "blocked", PREFIX, {
      role: "task",
    }));
    expect(labels).toEqual([L.task, L.blocked]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");
    expect(decide(issue([...labels, L.rework]), PREFIX)).toEqual({
      action: "start",
      kind: "implement",
      role: "task",
      trigger: L.rework,
      isRework: true,
    });
  });

  it("sends a blocked fast issue back into its implementation run", () => {
    const labels = applyUpdate([L.fast], labelUpdateAfterRun("implement", "blocked", PREFIX));
    expect(labels).toEqual([L.fast, L.blocked]);
    expect(decide(issue([...labels, L.rework]), PREFIX)).toMatchObject({
      kind: "implement",
      role: "epic",
      isRework: true,
    });
  });
});

describe("labelUpdateAfterRun: rework", () => {
  it("clears only the rework label on success, whatever the kind", () => {
    for (const kind of ALL_KINDS) {
      expect(labelUpdateAfterRun(kind, "success", PREFIX, { isRework: true })).toEqual({
        add: [],
        remove: [L.rework, L.failed, L.blocked],
      });
    }
  });

  it("leaves the gate label in place, so the human lands back on the same gate", () => {
    const update = labelUpdateAfterRun("prd", "success", PREFIX, { isRework: true });
    const labels = applyUpdate([L.specToApprove, L.rework], update);
    expect(labels).toEqual([L.specToApprove]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");
  });

  it("clears the blocked label once the answer has been worked in", () => {
    const update = labelUpdateAfterRun("implement", "success", PREFIX, {
      role: "task",
      isRework: true,
    });
    expect(applyUpdate([L.task, L.blocked, L.rework], update)).toEqual([L.task]);
  });

  it("keeps a reworked task in review", () => {
    const update = labelUpdateAfterRun("implement", "success", PREFIX, {
      role: "task",
      isRework: true,
    });
    expect(applyUpdate([L.task, L.inReview, L.rework], update)).toEqual([L.task, L.inReview]);
  });

  it("keeps a reworked wayfinder map at the decision gate", () => {
    const update = labelUpdateAfterRun("wayfinder", "success", PREFIX, { isRework: true });
    expect(applyUpdate([L.planned, L.rework], update)).toEqual([L.planned]);
  });

  it("drops the rework label on failure so the human can hang it again", () => {
    const update = labelUpdateAfterRun("slices", "failure", PREFIX, { isRework: true });
    expect(update).toEqual({ add: [L.failed], remove: [L.rework, L.blocked] });

    const labels = applyUpdate([L.planToApprove, L.rework], update);
    expect(labels).toEqual([L.planToApprove, L.failed]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");
    expect(decide(issue([...labels, L.rework]), PREFIX)).toMatchObject({
      kind: "slices",
      isRework: true,
    });
  });
});

describe("describeRunKind", () => {
  it("describes every kind, and no two kinds the same way", () => {
    for (const kind of ALL_KINDS) {
      expect(describeRunKind(kind).length).toBeGreaterThan(0);
    }
    expect(new Set(ALL_KINDS.map(describeRunKind)).size).toBe(ALL_KINDS.length);
  });

  it("covers the six kinds of the pipeline", () => {
    expect(ALL_KINDS).toEqual(["wayfinder", "adr", "prd", "slices", "tasks", "implement"]);
  });
});

describe("isRunKind", () => {
  it("accepts current kinds and rejects the retired ones", () => {
    for (const kind of ALL_KINDS) {
      expect(isRunKind(kind)).toBe(true);
    }
    expect(isRunKind("plan")).toBe(false);
    expect(isRunKind("spec")).toBe(false);
  });
});

describe("full lifecycle", () => {
  it("walks plan -> planned -> approved -> to-prd -> spec-to-approve -> to-plan -> to-tasks -> specced", () => {
    let labels = [L.plan];

    // Wayfinder.
    expect(decide(issue(labels), PREFIX)).toMatchObject({ action: "start", kind: "wayfinder" });
    labels = applyUpdate(labels, labelUpdateAfterRun("wayfinder", "success", PREFIX));
    expect(labels).toEqual([L.planned]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");

    // Gate 1: a human approves the wayfinder decisions.
    labels = [...labels, L.approved];
    expect(decide(issue(labels), PREFIX)).toMatchObject({ action: "start", kind: "adr" });
    labels = applyUpdate(labels, labelUpdateAfterRun("adr", "success", PREFIX));
    expect(labels).toEqual([L.toPrd]);

    // The PRD run is chained by the orchestrator, no human in between.
    expect(decide(issue(labels), PREFIX)).toMatchObject({ action: "start", kind: "prd" });
    labels = applyUpdate(labels, labelUpdateAfterRun("prd", "success", PREFIX));
    expect(labels).toEqual([L.specToApprove]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");

    // Gate 2: a human reads the ADRs and the PRD on the plan branch.
    labels = [...labels, L.toPlan];
    expect(decide(issue(labels), PREFIX)).toMatchObject({ action: "start", kind: "slices" });
    labels = applyUpdate(labels, labelUpdateAfterRun("slices", "success", PREFIX));
    expect(labels).toEqual([L.planToApprove]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");

    // Gate 3: a human reads the sliced plan and releases the task creation.
    labels = [...labels, L.toTasks];
    expect(decide(issue(labels), PREFIX)).toMatchObject({ action: "start", kind: "tasks" });
    labels = applyUpdate(labels, labelUpdateAfterRun("tasks", "success", PREFIX));
    expect(labels).toEqual([L.specced]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");
  });

  it("retries a failed stage after a human hangs the trigger back", () => {
    let labels = [L.toPrd];
    expect(decide(issue(labels), PREFIX)).toMatchObject({ kind: "prd" });

    labels = applyUpdate(labels, labelUpdateAfterRun("prd", "failure", PREFIX));
    expect(labels).toEqual([L.failed]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");

    labels = [...labels, L.toPrd];
    expect(decide(issue(labels), PREFIX)).toMatchObject({ kind: "prd" });
    labels = applyUpdate(labels, labelUpdateAfterRun("prd", "success", PREFIX));
    expect(labels).toEqual([L.specToApprove]);
  });

  it("walks a task from creation to review", () => {
    let labels = [L.task];
    expect(decide(issue(labels), PREFIX)).toMatchObject({ action: "start", role: "task" });
    labels = applyUpdate(
      labels,
      labelUpdateAfterRun("implement", "success", PREFIX, { role: "task" }),
    );
    expect(labels).toEqual([L.task, L.inReview]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");
  });

  it("walks a fast issue from trigger to review", () => {
    let labels = [L.fast];
    expect(decide(issue(labels), PREFIX)).toMatchObject({ action: "start", kind: "implement" });
    labels = applyUpdate(
      labels,
      labelUpdateAfterRun("implement", "success", PREFIX, { role: "epic" }),
    );
    expect(labels).toEqual([L.inReview]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");
  });

  it("retries a failed task after a human removes the failed label", () => {
    let labels = [L.task];
    labels = applyUpdate(
      labels,
      labelUpdateAfterRun("implement", "failure", PREFIX, { role: "task" }),
    );
    expect(labels).toEqual([L.task, L.failed]);
    expect(decide(issue(labels), PREFIX).action).toBe("idle");

    labels = labels.filter((label) => label !== L.failed);
    expect(decide(issue(labels), PREFIX)).toMatchObject({ action: "start", kind: "implement" });
  });
});

/** Same rules GitHub applies, and the same helper the orchestrator uses. */
function applyUpdate(labels: string[], update: { add: string[]; remove: string[] }): string[] {
  return applyLabelUpdate(labels, update);
}

describe("applyLabelUpdate", () => {
  it("removes, adds and never duplicates", () => {
    expect(applyLabelUpdate([L.toPrd, "bug"], { add: [L.specToApprove], remove: [L.toPrd] })).toEqual(
      [
        "bug",
        L.specToApprove,
      ],
    );
    expect(applyLabelUpdate([L.failed], { add: [L.failed], remove: [] })).toEqual([L.failed]);
  });

  it("leaves the input untouched", () => {
    const labels = [L.plan];
    applyLabelUpdate(labels, { add: [L.planned], remove: [L.plan] });
    expect(labels).toEqual([L.plan]);
  });
});
