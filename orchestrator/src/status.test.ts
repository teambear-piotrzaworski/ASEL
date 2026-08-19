import { describe, expect, it, vi } from "vitest";
import { labelsFor } from "./machine.js";
import { parseIssueMarkers, type IssueMarkers } from "./plan.js";
import {
  STATUS_BLOCK_END,
  STATUS_BLOCK_START,
  applyStatusBlock,
  renderStatusBlock,
  runKindLabel,
  statusVariantOf,
  stripStatusBlock,
  upsertStatusBlock,
  type StatusInput,
} from "./status.js";

const PREFIX = "asel";
const L = labelsFor(PREFIX);

const NO_MARKERS: IssueMarkers = { epicIssue: null, slice: null };

function input(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    labelPrefix: PREFIX,
    issueNumber: 42,
    issueUrl: "https://github.com/acme/example/issues/42",
    labels: [],
    markers: NO_MARKERS,
    activeRunKind: null,
    ...overrides,
  };
}

function block(overrides: Partial<StatusInput> = {}): string {
  return renderStatusBlock(input(overrides));
}

function checkedSteps(rendered: string): number {
  return rendered.split("\n").filter((line) => line.startsWith("- [x]")).length;
}

function totalSteps(rendered: string): number {
  return rendered.split("\n").filter((line) => line.startsWith("- [")).length;
}

function stageLine(rendered: string): string {
  return rendered.split("\n").find((line) => line.startsWith("**Stage:**")) ?? "";
}

function nextLine(rendered: string): string {
  return rendered.split("\n").find((line) => line.startsWith("**Next step:**")) ?? "";
}

describe("upsertStatusBlock: no block yet", () => {
  it("appends the block at the end, leaving the human text alone", () => {
    const body = "We need to rework the importer.\n\nSee the notes in #12.";
    const result = upsertStatusBlock(body, "<!-- ASEL:STATUS -->\nX\n<!-- /ASEL:STATUS -->");
    expect(result.startsWith(body)).toBe(true);
    expect(result.endsWith(STATUS_BLOCK_END)).toBe(true);
    expect(result).toContain("\n\n<!-- ASEL:STATUS -->");
  });

  it("turns an empty body into the block alone", () => {
    const rendered = block({ labels: [L.plan] });
    expect(upsertStatusBlock("", rendered)).toBe(rendered);
  });

  it("is stable: appending then upserting again changes nothing", () => {
    const rendered = block({ labels: [L.planned] });
    const once = upsertStatusBlock("Human text.", rendered);
    expect(upsertStatusBlock(once, rendered)).toBe(once);
  });
});

describe("upsertStatusBlock: block present", () => {
  it("replaces only what sits between the markers", () => {
    const body = [
      "Intro written by a human.",
      "",
      STATUS_BLOCK_START,
      "old content",
      STATUS_BLOCK_END,
      "",
      "Closing remark, also written by a human.",
    ].join("\n");
    const result = upsertStatusBlock(body, `${STATUS_BLOCK_START}\nnew content\n${STATUS_BLOCK_END}`);
    expect(result).toContain("Intro written by a human.");
    expect(result).toContain("Closing remark, also written by a human.");
    expect(result).toContain("new content");
    expect(result).not.toContain("old content");
  });

  it("does not move the block to the end", () => {
    const body = `${STATUS_BLOCK_START}\nold\n${STATUS_BLOCK_END}\n\nHuman text below.`;
    const result = upsertStatusBlock(body, `${STATUS_BLOCK_START}\nnew\n${STATUS_BLOCK_END}`);
    expect(result.endsWith("Human text below.")).toBe(true);
  });

  it("is idempotent", () => {
    const rendered = block({ labels: [L.specToApprove] });
    const body = upsertStatusBlock("Text.", rendered);
    expect(upsertStatusBlock(upsertStatusBlock(body, rendered), rendered)).toBe(body);
  });
});

describe("upsertStatusBlock: malformed input", () => {
  it("replaces the first block and leaves a duplicated one untouched", () => {
    const body = [
      `${STATUS_BLOCK_START}\nfirst\n${STATUS_BLOCK_END}`,
      "human note in between",
      `${STATUS_BLOCK_START}\nsecond\n${STATUS_BLOCK_END}`,
    ].join("\n\n");
    const result = upsertStatusBlock(body, `${STATUS_BLOCK_START}\nfresh\n${STATUS_BLOCK_END}`);
    expect(result).toContain("fresh");
    expect(result).not.toContain("first");
    expect(result).toContain("second");
    expect(result).toContain("human note in between");
  });

  it("keeps a dangling opening marker and everything around it", () => {
    const body = `Notes.\n${STATUS_BLOCK_START}\nsomething a human typed`;
    const result = upsertStatusBlock(body, `${STATUS_BLOCK_START}\nfresh\n${STATUS_BLOCK_END}`);
    expect(result).toContain("something a human typed");
    expect(result).toContain("Notes.");
    expect(result.endsWith(STATUS_BLOCK_END)).toBe(true);
  });

  it("stays stable after a dangling opening marker: the second pass replaces the real block", () => {
    const rendered = block({ labels: [L.planned] });
    const body = `Notes.\n${STATUS_BLOCK_START}\ndangling`;
    const once = upsertStatusBlock(body, rendered);
    const twice = upsertStatusBlock(once, rendered);
    expect(twice).toBe(once);
    expect(twice).toContain("dangling");
    expect(twice.split(STATUS_BLOCK_END)).toHaveLength(2);
  });

  it("ignores a closing marker that opens nothing", () => {
    const body = `Human text ${STATUS_BLOCK_END} more text`;
    const result = upsertStatusBlock(body, `${STATUS_BLOCK_START}\nfresh\n${STATUS_BLOCK_END}`);
    expect(result).toContain("Human text");
    expect(result).toContain("more text");
    expect(result).toContain("fresh");
    expect(upsertStatusBlock(result, `${STATUS_BLOCK_START}\nfresh\n${STATUS_BLOCK_END}`)).toBe(
      result,
    );
  });

  it("keeps CRLF bodies on CRLF and stays idempotent", () => {
    const rendered = block({ labels: [L.planned] });
    const body = "Written on Windows.\r\n\r\nSecond paragraph.";
    const once = upsertStatusBlock(body, rendered);
    expect(once).not.toMatch(/[^\r]\n/);
    expect(upsertStatusBlock(once, rendered)).toBe(once);
  });

  it("leaves a plain LF body on LF", () => {
    const rendered = block({ labels: [L.planned] });
    expect(upsertStatusBlock("Plain body.\n", rendered)).not.toContain("\r");
  });
});

describe("stripStatusBlock", () => {
  it("removes the block and keeps the human text", () => {
    const body = upsertStatusBlock("Please rework the importer.", block({ labels: [L.task] }));
    expect(stripStatusBlock(body)).toBe("Please rework the importer.");
  });

  it("keeps text on both sides", () => {
    const body = `Before.\n\n${STATUS_BLOCK_START}\nx\n${STATUS_BLOCK_END}\n\nAfter.`;
    expect(stripStatusBlock(body)).toBe("Before.\n\nAfter.");
  });

  it("is a no-op when there is no block", () => {
    expect(stripStatusBlock("Nothing here.")).toBe("Nothing here.");
  });
});

describe("applyStatusBlock", () => {
  it("writes once and never again while the body would not change", async () => {
    const write = vi.fn(async () => {});
    const rendered = block({ labels: [L.planned] });

    const first = await applyStatusBlock("Body.", rendered, write);
    expect(write).toHaveBeenCalledTimes(1);

    const second = await applyStatusBlock(first, rendered, write);
    expect(write).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("writes again once the state changed", async () => {
    const write = vi.fn(async () => {});
    const gate = await applyStatusBlock("Body.", block({ labels: [L.planned] }), write);
    await applyStatusBlock(gate, block({ labels: [L.toPrd] }), write);
    expect(write).toHaveBeenCalledTimes(2);
  });
});

describe("statusVariantOf", () => {
  it("recognizes tasks, fast issues and epics", () => {
    expect(statusVariantOf([L.task], PREFIX)).toBe("task");
    expect(statusVariantOf([L.fast], PREFIX)).toBe("fast");
    expect(statusVariantOf([L.planned], PREFIX)).toBe("epic");
    expect(statusVariantOf([], PREFIX)).toBe("epic");
  });

  it("still recognizes a fast issue after the fast label was cleared", () => {
    // A successful fast run removes asel:fast and adds asel:in-review.
    expect(statusVariantOf([L.inReview], PREFIX)).toBe("fast");
    expect(statusVariantOf([L.failed], PREFIX)).toBe("fast");
    expect(statusVariantOf([L.inReview, L.blocked], PREFIX)).toBe("fast");
  });

  it("keeps an epic in review inside the epic variant", () => {
    expect(statusVariantOf([L.specced, L.inReview], PREFIX)).toBe("epic");
  });

  it("lets the task label win over the fast label", () => {
    expect(statusVariantOf([L.task, L.fast], PREFIX)).toBe("task");
  });
});

describe("renderStatusBlock: epic", () => {
  it("wraps the block in the markers", () => {
    const rendered = block({ labels: [L.plan] });
    expect(rendered.startsWith(STATUS_BLOCK_START)).toBe(true);
    expect(rendered.endsWith(STATUS_BLOCK_END)).toBe(true);
  });

  it("names the plan branch", () => {
    expect(block({ labels: [L.planned] })).toContain("`asel/plan-42`");
  });

  it("shows the whole path as a checklist", () => {
    expect(totalSteps(block({ labels: [L.plan] }))).toBe(9);
  });

  it("ticks nothing before the wayfinder run", () => {
    const rendered = block({ labels: [L.plan] });
    expect(checkedSteps(rendered)).toBe(0);
    expect(stageLine(rendered)).toContain("wayfinder run queued");
    expect(nextLine(rendered)).toContain("Nothing to do");
  });

  it("says a run is in progress and marks the step that is running", () => {
    const rendered = block({ labels: [L.plan], activeRunKind: "wayfinder" });
    expect(stageLine(rendered)).toContain("wayfinder run in progress");
    expect(rendered).toContain("(running now)");
    expect(nextLine(rendered)).toContain("Nothing to do");
  });

  it("asks for the decisions at the wayfinder gate", () => {
    const rendered = block({ labels: [L.planned] });
    expect(checkedSteps(rendered)).toBe(1);
    expect(nextLine(rendered)).toContain(`\`${L.approved}\``);
  });

  it("counts the approval gate as passed once the adr run is triggered", () => {
    const rendered = block({ labels: [L.planned, L.approved] });
    expect(checkedSteps(rendered)).toBe(3);
    expect(stageLine(rendered)).toContain("ADR run");
  });

  it("chains the prd run without asking for anything", () => {
    const rendered = block({ labels: [L.toPrd] });
    expect(checkedSteps(rendered)).toBe(4);
    expect(stageLine(rendered)).toContain("PRD run");
    expect(nextLine(rendered)).toContain("Nothing to do");
  });

  it("asks for the spec review at the spec gate", () => {
    const rendered = block({ labels: [L.specToApprove] });
    expect(checkedSteps(rendered)).toBe(5);
    expect(stageLine(rendered)).toContain("ADRs and the PRD are waiting for review");
    expect(nextLine(rendered)).toContain(`\`${L.toPlan}\``);
  });

  it("reports the slicing run", () => {
    const rendered = block({ labels: [L.specToApprove, L.toPlan] });
    expect(checkedSteps(rendered)).toBe(6);
    expect(stageLine(rendered)).toContain("slicing run");
  });

  it("asks for the plan review at the plan gate", () => {
    const rendered = block({ labels: [L.planToApprove] });
    expect(checkedSteps(rendered)).toBe(7);
    expect(nextLine(rendered)).toContain(`\`${L.toTasks}\``);
  });

  it("reports the task creation run", () => {
    const rendered = block({ labels: [L.planToApprove, L.toTasks] });
    expect(checkedSteps(rendered)).toBe(8);
    expect(stageLine(rendered)).toContain("task creation run");
  });

  it("ticks everything once the epic is specced", () => {
    const rendered = block({ labels: [L.specced] });
    expect(checkedSteps(rendered)).toBe(9);
    expect(nextLine(rendered)).toContain("Follow the task issues");
  });

  it("tells an epic with no recognized label which one starts the pipeline", () => {
    const rendered = block({ labels: [] });
    expect(stageLine(rendered)).toContain("not started");
    expect(nextLine(rendered)).toContain(`\`${L.plan}\``);
  });

  it("names the label to set again after a failure", () => {
    expect(nextLine(block({ labels: [L.planned, L.failed] }))).toContain(`\`${L.approved}\``);
    expect(nextLine(block({ labels: [L.specToApprove, L.failed] }))).toContain(`\`${L.toPlan}\``);
    expect(nextLine(block({ labels: [L.planToApprove, L.failed] }))).toContain(`\`${L.toTasks}\``);
    expect(stageLine(block({ labels: [L.planned, L.failed] }))).toContain("FAILED");
  });

  it("offers the way back at every gate", () => {
    for (const gate of [L.planned, L.specToApprove, L.planToApprove, L.specced]) {
      expect(nextLine(block({ labels: [gate] }))).toContain(`\`${L.rework}\``);
    }
  });

  it("says which step is being repeated when rework is set", () => {
    expect(stageLine(block({ labels: [L.planned, L.rework] }))).toContain("wayfinder run repeats");
    expect(stageLine(block({ labels: [L.specToApprove, L.rework] }))).toContain("PRD run repeats");
    expect(stageLine(block({ labels: [L.planToApprove, L.rework] }))).toContain(
      "slicing run repeats",
    );
    expect(stageLine(block({ labels: [L.specced, L.rework] }))).toContain(
      "task creation run repeats",
    );
    expect(nextLine(block({ labels: [L.specToApprove, L.rework] }))).toContain("Nothing to do");
  });

  it("rewinds the checklist to the step being repeated", () => {
    expect(checkedSteps(block({ labels: [L.specToApprove, L.rework] }))).toBe(4);
    expect(checkedSteps(block({ labels: [L.planToApprove, L.rework] }))).toBe(6);
    expect(checkedSteps(block({ labels: [L.specced, L.rework] }))).toBe(8);
  });

  it("asks for an answer when a run stopped with a question", () => {
    const rendered = block({ labels: [L.specToApprove, L.blocked] });
    expect(stageLine(rendered)).toContain("STOPPED WITH A QUESTION");
    expect(nextLine(rendered)).toContain("Answer the question");
    expect(nextLine(rendered)).toContain(`\`${L.rework}\``);
  });

  it("does not call a blocked run a failed one", () => {
    const rendered = block({ labels: [L.planned, L.blocked] });
    expect(stageLine(rendered)).not.toContain("FAILED");
    expect(nextLine(rendered)).not.toContain("retry");
  });

  it("says so when rework has no state label to work with", () => {
    const rendered = block({ labels: [L.toPrd, L.rework] });
    expect(stageLine(rendered)).toContain("no state label");
    expect(nextLine(rendered)).toContain(`\`${L.rework}\``);
    // The checklist still shows the real stage instead of rewinding to zero.
    expect(checkedSteps(rendered)).toBe(4);
  });

  it("follows the configured label prefix", () => {
    const rendered = renderStatusBlock(
      input({ labelPrefix: "factory", labels: ["factory:spec-to-approve"] }),
    );
    expect(rendered).toContain("`factory:to-plan`");
  });
});

describe("renderStatusBlock: task", () => {
  const taskInput = (labels: string[], extra: Partial<StatusInput> = {}): StatusInput =>
    input({
      issueNumber: 57,
      issueUrl: "https://github.com/acme/example/issues/57",
      labels,
      markers: { epicIssue: 42, slice: 3 },
      ...extra,
    });

  it("links the epic and names the slice and the plan branch", () => {
    const rendered = renderStatusBlock(taskInput([L.task]));
    expect(rendered).toContain("[#42](https://github.com/acme/example/issues/42)");
    expect(rendered).toContain("**Slice number:** 3");
    expect(rendered).toContain("`asel/plan-42`");
  });

  it("says a queued task needs nothing from a human", () => {
    const rendered = renderStatusBlock(taskInput([L.task]));
    expect(stageLine(rendered)).toContain("waiting in the queue");
    expect(nextLine(rendered)).toContain("Nothing to do");
  });

  it("says when the implementation run is working", () => {
    const rendered = renderStatusBlock(taskInput([L.task], { activeRunKind: "implement" }));
    expect(stageLine(rendered)).toContain("implementation run in progress");
  });

  it("asks for a review once the commits are there", () => {
    const rendered = renderStatusBlock(taskInput([L.task, L.inReview]));
    expect(stageLine(rendered)).toContain("waiting for review");
    expect(nextLine(rendered)).toContain("`asel/plan-42`");
    expect(nextLine(rendered)).toContain("close this issue");
  });

  it("explains the retry after a failure", () => {
    const rendered = renderStatusBlock(taskInput([L.task, L.failed]));
    expect(stageLine(rendered)).toContain("FAILED");
    expect(nextLine(rendered)).toContain(`remove \`${L.failed}\``);
  });

  it("offers the rework path to the reviewer", () => {
    expect(nextLine(renderStatusBlock(taskInput([L.task, L.inReview])))).toContain(
      `\`${L.rework}\``,
    );
  });

  it("says the implementation is being redone when rework is set", () => {
    const rendered = renderStatusBlock(taskInput([L.task, L.inReview, L.rework]));
    expect(stageLine(rendered)).toContain("rework requested");
    expect(nextLine(rendered)).toContain("Nothing to do");
  });

  it("says so when rework sits on a task that is not in review", () => {
    const rendered = renderStatusBlock(taskInput([L.task, L.rework]));
    expect(stageLine(rendered)).toContain("not waiting for review");
    expect(nextLine(rendered)).toContain(`\`${L.inReview}\``);
  });

  it("asks the human to answer a blocked task and set rework", () => {
    const rendered = renderStatusBlock(taskInput([L.task, L.blocked]));
    expect(stageLine(rendered)).toContain("asked you a question");
    expect(stageLine(rendered)).not.toContain("FAILED");
    expect(nextLine(rendered)).toContain(`\`${L.rework}\``);
  });

  it("accepts rework next to blocked, because that is how an answer is handed in", () => {
    const rendered = renderStatusBlock(taskInput([L.task, L.blocked, L.rework]));
    expect(stageLine(rendered)).toContain("rework requested");
    expect(nextLine(rendered)).toContain("Nothing to do");
  });

  it("handles a task issue written by hand, without markers", () => {
    const rendered = renderStatusBlock(taskInput([L.task], { markers: NO_MARKERS }));
    expect(rendered).toContain("**Epic:** none");
    expect(rendered).toContain("`asel/issue-57`");
    expect(rendered).toContain("**Slice number:** not set");
  });

  it("has no checklist: a task is one run, not a pipeline", () => {
    expect(totalSteps(renderStatusBlock(taskInput([L.task])))).toBe(0);
  });
});

describe("renderStatusBlock: fast", () => {
  it("stays minimal and points at its own branch", () => {
    const rendered = renderStatusBlock(input({ issueNumber: 7, labels: [L.fast] }));
    expect(rendered).toContain("**Mode:** fast track");
    expect(rendered).toContain("`asel/issue-7`");
    expect(totalSteps(rendered)).toBe(0);
    expect(rendered).not.toContain("**Epic:**");
  });

  it("asks for a review when the fast run finished", () => {
    const rendered = renderStatusBlock(input({ issueNumber: 7, labels: [L.inReview] }));
    expect(rendered).toContain("**Mode:** fast track");
    expect(nextLine(rendered)).toContain("Review the commits");
    expect(nextLine(rendered)).toContain(`\`${L.rework}\``);
  });

  it("asks for an answer when the fast run stopped with a question", () => {
    const rendered = renderStatusBlock(input({ issueNumber: 7, labels: [L.fast, L.blocked] }));
    expect(rendered).toContain("**Mode:** fast track");
    expect(stageLine(rendered)).toContain("asked you a question");
    expect(nextLine(rendered)).toContain(`\`${L.rework}\``);
  });

  it("says the fast run is being redone when rework is set", () => {
    const rendered = renderStatusBlock(
      input({ issueNumber: 7, labels: [L.fast, L.inReview, L.rework] }),
    );
    expect(rendered).toContain("**Mode:** fast track");
    expect(stageLine(rendered)).toContain("rework requested");
  });
});

describe("renderStatusBlock: does not poison the marker parser", () => {
  it("adds no epic or slice marker of its own", () => {
    for (const rendered of [
      block({ labels: [L.planned] }),
      renderStatusBlock(input({ labels: [L.task], markers: { epicIssue: 42, slice: 3 } })),
      renderStatusBlock(input({ labels: [L.task], markers: NO_MARKERS })),
      renderStatusBlock(input({ labels: [L.fast] })),
    ]) {
      expect(parseIssueMarkers(rendered)).toEqual({ epicIssue: null, slice: null });
    }
  });

  it("leaves the markers of a real body readable through the block", () => {
    const body = upsertStatusBlock(
      "ASEL_EPIC: 42\nASEL_SLICE: 3\n\nDo the thing.",
      renderStatusBlock(input({ labels: [L.task], markers: { epicIssue: 42, slice: 3 } })),
    );
    expect(parseIssueMarkers(body)).toEqual({ epicIssue: 42, slice: 3 });
  });
});

describe("runKindLabel", () => {
  it("names every kind once", () => {
    const names = (["wayfinder", "adr", "prd", "slices", "tasks", "implement"] as const).map(
      runKindLabel,
    );
    expect(new Set(names).size).toBe(names.length);
  });
});
