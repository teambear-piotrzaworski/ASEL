import { describe, expect, it } from "vitest";
import {
  compareRuns,
  describeSkipReason,
  isTaskGateOpen,
  issueBranchFor,
  issueKeyFor,
  parseIssueMarkers,
  planBranchFor,
  planContextFor,
  planKeyFor,
  scheduleRuns,
  sortRuns,
  type SchedulableRun,
  type SchedulerLimits,
  type SchedulerSnapshot,
  type StalledTask,
} from "./plan.js";

const REPO = "acme/example";

function taskBody(epic: number | null, slice: number | null): string {
  const lines = ["Implement the thing.", ""];
  if (epic !== null) {
    lines.push(`ASEL_EPIC: ${epic}`);
  }
  if (slice !== null) {
    lines.push(`ASEL_SLICE: ${slice}`);
  }
  return lines.join("\n");
}

describe("branch names", () => {
  it("derives the plan branch from the epic issue number", () => {
    expect(planBranchFor(42)).toBe("asel/plan-42");
    expect(issueBranchFor(7)).toBe("asel/issue-7");
  });

  it("keeps plan branches and standalone branches apart", () => {
    expect(planBranchFor(42)).not.toBe(issueBranchFor(42));
  });
});

describe("parseIssueMarkers", () => {
  it("reads both markers", () => {
    expect(parseIssueMarkers(taskBody(42, 3))).toEqual({ epicIssue: 42, slice: 3 });
  });

  it("survives a body without markers", () => {
    expect(parseIssueMarkers("just a human writing prose")).toEqual({
      epicIssue: null,
      slice: null,
    });
    expect(parseIssueMarkers("")).toEqual({ epicIssue: null, slice: null });
  });

  it("finds the markers wherever they sit in the body", () => {
    const body = [
      "## Task",
      "Some description that mentions ASEL_EPIC in prose without a colon.",
      "",
      "ASEL_SLICE: 2",
      "more text",
      "ASEL_EPIC: 108",
      "",
      "closing words",
    ].join("\n");
    expect(parseIssueMarkers(body)).toEqual({ epicIssue: 108, slice: 2 });
  });

  it("tolerates the decoration a human or an agent adds", () => {
    const body = [
      "- **ASEL_EPIC:** #42 (the epic issue)",
      "> `ASEL_SLICE` = 5 -- second wave",
      "",
    ].join("\n");
    expect(parseIssueMarkers(body)).toEqual({ epicIssue: 42, slice: 5 });
  });

  it("accepts windows line endings", () => {
    expect(parseIssueMarkers("intro\r\nASEL_EPIC: 9\r\nASEL_SLICE: 1\r\n")).toEqual({
      epicIssue: 9,
      slice: 1,
    });
  });

  it("ignores garbage values instead of guessing", () => {
    expect(parseIssueMarkers("ASEL_EPIC: none\nASEL_SLICE: later")).toEqual({
      epicIssue: null,
      slice: null,
    });
    expect(parseIssueMarkers("ASEL_EPIC: 0\nASEL_SLICE: -3")).toEqual({
      epicIssue: null,
      slice: null,
    });
  });

  it("takes the first valid occurrence when a human duplicates a marker", () => {
    expect(parseIssueMarkers("ASEL_EPIC: 11\nASEL_EPIC: 12")).toMatchObject({ epicIssue: 11 });
  });

  it("still understands the older bare Slice line", () => {
    expect(parseIssueMarkers("ASEL_EPIC: 42\nSlice: 4")).toEqual({ epicIssue: 42, slice: 4 });
  });

  it("prefers the explicit marker over the legacy one", () => {
    expect(parseIssueMarkers("Slice: 9\nASEL_SLICE: 2")).toMatchObject({ slice: 2 });
  });
});

describe("planContextFor", () => {
  it("puts every pipeline run of an epic on the plan branch of that epic", () => {
    for (const kind of ["wayfinder", "adr", "prd", "slices", "tasks"] as const) {
      expect(
        planContextFor({
          repo: REPO,
          issueNumber: 42,
          issueBody: "epic body",
          kind,
          role: "epic",
        }),
      ).toEqual({
        planKey: planKeyFor(REPO, 42),
        epicIssue: 42,
        branch: "asel/plan-42",
        slice: null,
      });
    }
  });

  it("puts a task on the plan branch named by its marker", () => {
    expect(
      planContextFor({
        repo: REPO,
        issueNumber: 57,
        issueBody: taskBody(42, 2),
        kind: "implement",
        role: "task",
      }),
    ).toEqual({
      planKey: planKeyFor(REPO, 42),
      epicIssue: 42,
      branch: "asel/plan-42",
      slice: 2,
    });
  });

  it("falls back to a branch per issue when a task has no epic marker", () => {
    expect(
      planContextFor({
        repo: REPO,
        issueNumber: 57,
        issueBody: "written by hand\nASEL_SLICE: 1\nno epic marker anywhere",
        kind: "implement",
        role: "task",
      }),
    ).toEqual({ planKey: null, epicIssue: null, branch: "asel/issue-57", slice: 1 });
  });

  it("ignores a marker mentioned mid sentence, because markers are lines", () => {
    expect(
      planContextFor({
        repo: REPO,
        issueNumber: 57,
        issueBody: "see the epic, ASEL_EPIC: 42 was written inline in prose",
        kind: "implement",
        role: "task",
      }),
    ).toMatchObject({ planKey: null, branch: "asel/issue-57" });
  });

  it("keeps the fast track on its own branch even if someone pastes a marker", () => {
    expect(
      planContextFor({
        repo: REPO,
        issueNumber: 8,
        issueBody: taskBody(42, 1),
        kind: "implement",
        role: "epic",
      }),
    ).toEqual({ planKey: null, epicIssue: null, branch: "asel/issue-8", slice: null });
  });

  it("scopes the plan key by repository", () => {
    const a = planContextFor({
      repo: "acme/a",
      issueNumber: 42,
      issueBody: "",
      kind: "adr",
      role: "epic",
    });
    const b = planContextFor({
      repo: "acme/b",
      issueNumber: 42,
      issueBody: "",
      kind: "adr",
      role: "epic",
    });
    expect(a.planKey).not.toBe(b.planKey);
  });
});

describe("isTaskGateOpen", () => {
  it("is open by default and closed only on the explicit value", () => {
    expect(isTaskGateOpen(undefined)).toBe(true);
    expect(isTaskGateOpen("open")).toBe(true);
    expect(isTaskGateOpen("")).toBe(true);
    expect(isTaskGateOpen("anything")).toBe(true);
    expect(isTaskGateOpen("closed")).toBe(false);
    expect(isTaskGateOpen(" CLOSED ")).toBe(false);
  });
});

function run(overrides: Partial<SchedulableRun> & { issueNumber: number }): SchedulableRun {
  return {
    issueKey: issueKeyFor(REPO, overrides.issueNumber),
    planKey: null,
    kind: "implement",
    role: "task",
    slice: null,
    ...overrides,
  };
}

describe("run ordering", () => {
  it("orders tasks by slice, then by issue number", () => {
    const runs = [
      run({ issueNumber: 30, slice: 2 }),
      run({ issueNumber: 10, slice: 3 }),
      run({ issueNumber: 20, slice: 2 }),
      run({ issueNumber: 5, slice: 1 }),
    ];
    expect(sortRuns(runs).map((item) => item.issueNumber)).toEqual([5, 20, 30, 10]);
  });

  it("sends tasks without a slice marker to the back of the queue", () => {
    const runs = [
      run({ issueNumber: 1, slice: null }),
      run({ issueNumber: 2, slice: 9 }),
      run({ issueNumber: 3, slice: null }),
    ];
    expect(sortRuns(runs).map((item) => item.issueNumber)).toEqual([2, 1, 3]);
  });

  it("lets a pipeline run of an epic go before the implementation runs", () => {
    const runs = [
      run({ issueNumber: 60, slice: 1 }),
      run({ issueNumber: 42, kind: "tasks", role: "epic" }),
    ];
    expect(sortRuns(runs).map((item) => item.issueNumber)).toEqual([42, 60]);
  });

  it("is a total order, so the same input always yields the same queue", () => {
    const a = run({ issueNumber: 7, slice: 1 });
    const b = run({ issueNumber: 7, slice: 1 });
    expect(compareRuns(a, b)).toBe(0);
  });
});

const NO_ACTIVITY: SchedulerSnapshot = {
  activeTotal: 0,
  activeInProject: 0,
  busyIssues: [],
  busyPlans: [],
  stalledTasks: [],
};

const ROOMY: SchedulerLimits = { global: 10, project: 10, taskGateOpen: true };

function started(decisions: ReturnType<typeof scheduleRuns>): number[] {
  return decisions.filter((decision) => decision.start).map((decision) => decision.run.issueNumber);
}

describe("scheduleRuns: one active run per plan", () => {
  const planKey = planKeyFor(REPO, 42);

  it("starts only the first task of a plan and makes the rest wait", () => {
    const decisions = scheduleRuns(
      [
        run({ issueNumber: 51, slice: 1, planKey }),
        run({ issueNumber: 52, slice: 2, planKey }),
        run({ issueNumber: 53, slice: 2, planKey }),
      ],
      NO_ACTIVITY,
      ROOMY,
    );
    expect(started(decisions)).toEqual([51]);
    expect(decisions[1]?.reason).toEqual({ code: "plan_busy", planKey });
    expect(decisions[2]?.reason).toEqual({ code: "plan_busy", planKey });
  });

  it("counts the epic runs and the task runs of one plan together", () => {
    const decisions = scheduleRuns(
      [run({ issueNumber: 51, slice: 1, planKey }), run({ issueNumber: 42, kind: "tasks", role: "epic", planKey })],
      NO_ACTIVITY,
      ROOMY,
    );
    expect(started(decisions)).toEqual([42]);
    expect(decisions[1]?.reason).toEqual({ code: "plan_busy", planKey });
  });

  it("respects a run of that plan that is already active", () => {
    const decisions = scheduleRuns([run({ issueNumber: 51, slice: 1, planKey })], {
      ...NO_ACTIVITY,
      activeTotal: 1,
      activeInProject: 1,
      busyPlans: [planKey],
    }, ROOMY);
    expect(started(decisions)).toEqual([]);
  });

  it("lets different plans and standalone runs go in parallel", () => {
    const other = planKeyFor(REPO, 99);
    const decisions = scheduleRuns(
      [
        run({ issueNumber: 51, slice: 1, planKey }),
        run({ issueNumber: 61, slice: 1, planKey: other }),
        run({ issueNumber: 71, role: "epic" }),
      ],
      NO_ACTIVITY,
      ROOMY,
    );
    expect(started(decisions).sort((a, b) => a - b)).toEqual([51, 61, 71]);
  });

  it("does not serialize two tasks that carry no epic marker", () => {
    const decisions = scheduleRuns(
      [run({ issueNumber: 81 }), run({ issueNumber: 82 })],
      NO_ACTIVITY,
      ROOMY,
    );
    expect(started(decisions)).toEqual([81, 82]);
  });

  it("starts the lowest slice first when several tasks of a plan are pending", () => {
    const decisions = scheduleRuns(
      [
        run({ issueNumber: 53, slice: 3, planKey }),
        run({ issueNumber: 51, slice: 1, planKey }),
        run({ issueNumber: 52, slice: 2, planKey }),
      ],
      NO_ACTIVITY,
      ROOMY,
    );
    expect(started(decisions)).toEqual([51]);
  });
});

describe("scheduleRuns: existing rules still apply", () => {
  it("skips an issue that already has an active run", () => {
    const decisions = scheduleRuns([run({ issueNumber: 51 })], {
      ...NO_ACTIVITY,
      activeTotal: 1,
      activeInProject: 1,
      busyIssues: [issueKeyFor(REPO, 51)],
    }, ROOMY);
    expect(started(decisions)).toEqual([]);
    expect(decisions[0]?.reason).toEqual({ code: "issue_busy" });
  });

  it("honours the global limit", () => {
    const decisions = scheduleRuns(
      [run({ issueNumber: 51 }), run({ issueNumber: 52 })],
      { ...NO_ACTIVITY, activeTotal: 1 },
      { global: 2, project: 10, taskGateOpen: true },
    );
    expect(started(decisions)).toEqual([51]);
    expect(decisions[1]?.reason).toEqual({ code: "global_limit", limit: 2 });
  });

  it("honours the per project limit", () => {
    const decisions = scheduleRuns(
      [run({ issueNumber: 51 }), run({ issueNumber: 52 })],
      NO_ACTIVITY,
      { global: 10, project: 1, taskGateOpen: true },
    );
    expect(started(decisions)).toEqual([51]);
    expect(decisions[1]?.reason).toEqual({ code: "project_limit", limit: 1 });
  });
});

describe("scheduleRuns: task gate", () => {
  const planKey = planKeyFor(REPO, 42);
  const closed: SchedulerLimits = { ...ROOMY, taskGateOpen: false };

  it("stops every task implementation run", () => {
    const decisions = scheduleRuns(
      [run({ issueNumber: 51, slice: 1, planKey }), run({ issueNumber: 52, slice: 2, planKey })],
      NO_ACTIVITY,
      closed,
    );
    expect(started(decisions)).toEqual([]);
    expect(decisions[0]?.reason).toEqual({ code: "task_gate_closed" });
  });

  it("leaves the planning pipeline and the fast track alone", () => {
    const decisions = scheduleRuns(
      [
        run({ issueNumber: 42, kind: "tasks", role: "epic", planKey }),
        run({ issueNumber: 8, role: "epic" }),
      ],
      NO_ACTIVITY,
      closed,
    );
    expect(started(decisions).sort((a, b) => a - b)).toEqual([8, 42]);
  });

  it("outranks the plan rule: nothing starts even with a free plan", () => {
    const decisions = scheduleRuns([run({ issueNumber: 51, slice: 1 })], NO_ACTIVITY, closed);
    expect(started(decisions)).toEqual([]);
  });
});

describe("scheduleRuns: a stalled plan starts no later task", () => {
  const planKey = planKeyFor(REPO, 42);
  const stalled = (issueNumber: number, slice: number | null): StalledTask => ({
    planKey,
    issueNumber,
    slice,
  });
  const withStalled = (tasks: StalledTask[]): SchedulerSnapshot => ({
    ...NO_ACTIVITY,
    stalledTasks: tasks,
  });

  it("holds every slice after a failed or blocked one", () => {
    const decisions = scheduleRuns(
      [
        run({ issueNumber: 53, slice: 3, planKey }),
        run({ issueNumber: 54, slice: 4, planKey }),
      ],
      withStalled([stalled(52, 2)]),
      ROOMY,
    );
    expect(started(decisions)).toEqual([]);
    expect(decisions.map((decision) => decision.reason)).toEqual([
      { code: "plan_stalled", planKey, blockingIssue: 52 },
      { code: "plan_stalled", planKey, blockingIssue: 52 },
    ]);
  });

  it("lets the rework of the stalled task itself start", () => {
    const decisions = scheduleRuns(
      [run({ issueNumber: 52, slice: 2, planKey })],
      withStalled([stalled(52, 2)]),
      ROOMY,
    );
    expect(started(decisions)).toEqual([52]);
  });

  it("lets an earlier slice run ahead of a stalled later one", () => {
    // Slice 3 asked a question that only slice 2's result can answer: the
    // retry of slice 2 must not be deadlocked by the stop label on slice 3.
    const decisions = scheduleRuns(
      [run({ issueNumber: 52, slice: 2, planKey })],
      withStalled([stalled(53, 3)]),
      ROOMY,
    );
    expect(started(decisions)).toEqual([52]);
  });

  it("reports the earliest of several stalled tasks", () => {
    const decisions = scheduleRuns(
      [run({ issueNumber: 55, slice: 5, planKey })],
      withStalled([stalled(54, 4), stalled(52, 2)]),
      ROOMY,
    );
    expect(decisions[0]?.reason).toEqual({ code: "plan_stalled", planKey, blockingIssue: 52 });
  });

  it("treats a stalled task without a slice marker as the last slice", () => {
    // A stalled unmarked task holds only the unmarked tasks behind it (by
    // issue number); every numbered slice sorts before it and stays free.
    const numbered = scheduleRuns(
      [run({ issueNumber: 53, slice: 3, planKey })],
      withStalled([stalled(59, null)]),
      ROOMY,
    );
    expect(started(numbered)).toEqual([53]);

    const unmarked = scheduleRuns(
      [run({ issueNumber: 60, slice: null, planKey })],
      withStalled([stalled(59, null)]),
      ROOMY,
    );
    expect(unmarked[0]?.reason).toEqual({ code: "plan_stalled", planKey, blockingIssue: 59 });
  });

  it("leaves other plans and the pipeline runs alone", () => {
    const otherPlan = planKeyFor(REPO, 7);
    const decisions = scheduleRuns(
      [
        run({ issueNumber: 71, slice: 9, planKey: otherPlan }),
        run({ issueNumber: 42, kind: "slices", role: "epic", planKey }),
      ],
      withStalled([stalled(52, 2)]),
      ROOMY,
    );
    expect(started(decisions)).toEqual([42, 71]);
  });
});

describe("describeSkipReason", () => {
  it("explains every reason in words", () => {
    expect(describeSkipReason({ code: "task_gate_closed" })).toContain("ASEL_TASK_GATE");
    expect(describeSkipReason({ code: "plan_busy", planKey: "a#1" })).toContain("a#1");
    expect(describeSkipReason({ code: "issue_busy" }).length).toBeGreaterThan(0);
    expect(describeSkipReason({ code: "plan_stalled", planKey: "a#1", blockingIssue: 52 })).toContain(
      "#52",
    );
    expect(describeSkipReason({ code: "global_limit", limit: 2 })).toContain("2");
    expect(describeSkipReason({ code: "project_limit", limit: 1 })).toContain("1");
  });
});
