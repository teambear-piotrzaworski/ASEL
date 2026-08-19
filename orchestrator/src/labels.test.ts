import { describe, expect, it, vi } from "vitest";
import {
  LABEL_COLORS,
  ensureLabels,
  labelDefinitions,
  planLabelBootstrap,
  sliceLabelDefinition,
  type LabelApi,
  type RepoLabel,
} from "./labels.js";
import { createLogger } from "./logger.js";
import { allLabels, labelsFor, sliceLabelFor } from "./machine.js";

const PREFIX = "asel";
const L = labelsFor(PREFIX);
const log = createLogger("test");

function definition(name: string) {
  const found = labelDefinitions(PREFIX).find((label) => label.name === name);
  if (found === undefined) {
    throw new Error(`no definition for ${name}`);
  }
  return found;
}

describe("labelDefinitions", () => {
  it("covers exactly the labels of the state machine", () => {
    const names = labelDefinitions(PREFIX).map((label) => label.name);
    expect(names).toHaveLength(15);
    expect(new Set(names)).toEqual(new Set(allLabels(PREFIX)));
  });

  it("follows the configured prefix", () => {
    const names = labelDefinitions("factory").map((label) => label.name);
    expect(names).toContain("factory:plan-to-approve");
    expect(names.every((name) => name.startsWith("factory:"))).toBe(true);
  });

  it("describes every label within GitHub's 100 character limit", () => {
    for (const label of labelDefinitions("a-rather-long-prefix")) {
      expect(label.description.length).toBeGreaterThan(0);
      expect(label.description.length).toBeLessThanOrEqual(100);
    }
  });

  it("uses six digit hex colours without a hash", () => {
    for (const label of labelDefinitions(PREFIX)) {
      expect(label.color).toMatch(/^[0-9a-f]{6}$/);
    }
  });

  it("paints the labels a human hangs in one colour", () => {
    for (const name of [L.plan, L.rework, L.approved, L.toPlan, L.toTasks, L.fast]) {
      expect(definition(name).role).toBe("human");
      expect(definition(name).color).toBe(LABEL_COLORS.human);
    }
  });

  it("paints the states the orchestrator chains itself in another colour", () => {
    for (const name of [L.toPrd, L.specced]) {
      expect(definition(name).role).toBe("machine");
      expect(definition(name).color).toBe(LABEL_COLORS.machine);
    }
  });

  it("paints the gates waiting for a human in a third colour", () => {
    for (const name of [L.planned, L.specToApprove, L.planToApprove, L.inReview]) {
      expect(definition(name).role).toBe("gate");
      expect(definition(name).color).toBe(LABEL_COLORS.gate);
    }
  });

  it("keeps failed red, and task and slice labels apart from everything else", () => {
    expect(definition(L.failed).color).toBe(LABEL_COLORS.failure);
    expect(definition(L.task).color).toBe(LABEL_COLORS.task);
    expect(new Set(Object.values(LABEL_COLORS)).size).toBe(Object.keys(LABEL_COLORS).length);
  });

  it("tells a blocked run apart from a failed one at a glance", () => {
    // Two different situations, two different reactions: a failure is debugged,
    // a question is answered. Sharing the red would blur exactly that.
    expect(definition(L.blocked).role).toBe("blocked");
    expect(definition(L.blocked).color).toBe(LABEL_COLORS.blocked);
    expect(definition(L.blocked).color).not.toBe(LABEL_COLORS.failure);
  });

  it("tells a blocked issue how to get unblocked", () => {
    expect(definition(L.blocked).description).toContain(L.rework);
    expect(definition(L.blocked).description).toContain("comment");
  });

  it("says what happens when a trigger label is hung", () => {
    expect(definition(L.rework).description).toContain("repeats");
    expect(definition(L.plan).description).toContain("wayfinder");
    expect(definition(L.toTasks).description).toContain("task");
    expect(definition(L.planned).description).toContain(L.approved);
    expect(definition(L.specToApprove).description).toContain(L.toPlan);
    expect(definition(L.planToApprove).description).toContain(L.toTasks);
  });
});

describe("sliceLabelDefinition", () => {
  it("is not part of the bootstrap set but shares the palette", () => {
    const slice = sliceLabelDefinition(PREFIX, 3);
    expect(slice.name).toBe(sliceLabelFor(PREFIX, 3));
    expect(slice.color).toBe(LABEL_COLORS.slice);
    expect(slice.description.length).toBeLessThanOrEqual(100);
    expect(labelDefinitions(PREFIX).map((label) => label.name)).not.toContain(slice.name);
  });
});

describe("planLabelBootstrap", () => {
  const desired = labelDefinitions(PREFIX);

  it("creates everything in an empty repository", () => {
    const plan = planLabelBootstrap([], desired);
    expect(plan.create).toHaveLength(15);
    expect(plan.update).toHaveLength(0);
  });

  it("does nothing when the labels already match", () => {
    const existing: RepoLabel[] = desired.map((label) => ({
      name: label.name,
      color: label.color,
      description: label.description,
    }));
    expect(planLabelBootstrap(existing, desired)).toEqual({ create: [], update: [] });
  });

  it("corrects a description that no longer says what the label does", () => {
    const existing: RepoLabel[] = [{ name: L.plan, color: "ffffff", description: "old text" }];
    const plan = planLabelBootstrap(existing, desired);
    expect(plan.update).toEqual([{ name: L.plan, description: definition(L.plan).description }]);
    expect(plan.create.map((label) => label.name)).not.toContain(L.plan);
  });

  it("never repaints a colour somebody chose", () => {
    const existing: RepoLabel[] = desired.map((label) => ({
      name: label.name,
      color: "000000",
      description: label.description,
    }));
    const plan = planLabelBootstrap(existing, desired);
    expect(plan.create).toHaveLength(0);
    expect(plan.update).toHaveLength(0);
  });

  it("matches names case insensitively, like GitHub does", () => {
    const existing: RepoLabel[] = [
      { name: "ASEL:PLAN", color: "ffffff", description: definition(L.plan).description },
    ];
    const plan = planLabelBootstrap(existing, desired);
    expect(plan.create.map((label) => label.name)).not.toContain(L.plan);
    expect(plan.update).toHaveLength(0);
  });

  it("keeps foreign labels out of it", () => {
    const existing: RepoLabel[] = [{ name: "bug", color: "d73a4a", description: "Something broke" }];
    const plan = planLabelBootstrap(existing, desired);
    expect(plan.create).toHaveLength(15);
    expect(plan.update).toHaveLength(0);
  });
});

function fakeApi(overrides: Partial<LabelApi> = {}): LabelApi {
  return {
    listLabels: async () => [],
    createLabel: async () => {},
    updateLabel: async () => {},
    ...overrides,
  };
}

describe("ensureLabels", () => {
  it("creates the missing labels", async () => {
    const createLabel = vi.fn(async () => {});
    const report = await ensureLabels(
      fakeApi({ createLabel }),
      "acme/example",
      PREFIX,
      log,
    );
    expect(createLabel).toHaveBeenCalledTimes(15);
    expect(report.created).toHaveLength(15);
    expect(report.failed).toHaveLength(0);
  });

  it("sends no request when the repository is already set up", async () => {
    const createLabel = vi.fn(async () => {});
    const updateLabel = vi.fn(async () => {});
    const existing: RepoLabel[] = labelDefinitions(PREFIX).map((label) => ({
      name: label.name,
      color: label.color,
      description: label.description,
    }));
    await ensureLabels(
      fakeApi({ listLabels: async () => existing, createLabel, updateLabel }),
      "acme/example",
      PREFIX,
      log,
    );
    expect(createLabel).not.toHaveBeenCalled();
    expect(updateLabel).not.toHaveBeenCalled();
  });

  it("survives a token that may not write labels", async () => {
    const report = await ensureLabels(
      fakeApi({
        createLabel: async () => {
          throw new Error("GitHub POST /labels failed with 403");
        },
      }),
      "acme/example",
      PREFIX,
      log,
    );
    expect(report.created).toHaveLength(0);
    expect(report.failed).toHaveLength(15);
  });

  it("survives a token that may not even list labels", async () => {
    const createLabel = vi.fn(async () => {});
    const report = await ensureLabels(
      fakeApi({
        listLabels: async () => {
          throw new Error("GitHub GET /labels failed with 404");
        },
        createLabel,
      }),
      "acme/example",
      PREFIX,
      log,
    );
    expect(createLabel).not.toHaveBeenCalled();
    expect(report).toEqual({ created: [], updated: [], failed: [] });
  });
});
