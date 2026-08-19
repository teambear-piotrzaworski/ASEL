/**
 * Label bootstrap for the repositories in the registry.
 *
 * The factory is driven by labels, so every repository it touches needs them to
 * exist, with a description saying what happens when the label is hung on an
 * issue, and a colour that tells the three groups apart at a glance:
 *
 * - blue: a human sets it, and something starts
 * - grey: the orchestrator sets it while chaining stages, nobody has to act
 * - amber: a gate, the process waits for a person
 * - red: a run failed
 * - pink: a run stopped on a question, it waits for an answer (never red: a
 *   question is not a failure, and the two need different reactions)
 * - purple: an implementation task issue
 * - pale blue: the dynamic `asel:slice-<n>` marker labels
 *
 * Descriptions are English (they land in project repositories) and stay well
 * under GitHub's 100 character limit.
 *
 * Update policy for labels that already exist: the DESCRIPTION is corrected when
 * it differs, the COLOUR is never touched. The description is documentation the
 * factory owns and a wrong one actively misleads; the colour is cosmetics a
 * project may have themed on purpose, and repainting somebody's labels on every
 * start is exactly the kind of nuisance that makes people turn the bootstrap
 * off.
 */
import type { Logger } from "./logger.js";
import { labelsFor, sliceLabelFor } from "./machine.js";

export type LabelRole = "human" | "machine" | "gate" | "failure" | "blocked" | "task" | "slice";

export const LABEL_COLORS: Record<LabelRole, string> = {
  human: "1d76db",
  machine: "ededed",
  gate: "fbca04",
  failure: "b60205",
  blocked: "d876e3",
  task: "5319e7",
  slice: "c5def5",
};

export interface LabelDefinition {
  name: string;
  description: string;
  color: string;
  role: LabelRole;
}

/** A label as GitHub reports it. */
export interface RepoLabel {
  name: string;
  color: string;
  description: string;
}

/**
 * The 15 labels of the state machine. The dynamic `asel:slice-<n>` labels are
 * deliberately absent: they are created by the tasks run, one per slice, and
 * there is no way to know up front how many a plan will have.
 */
export function labelDefinitions(prefix: string): LabelDefinition[] {
  const L = labelsFor(prefix);
  const define = (name: string, role: LabelRole, description: string): LabelDefinition => ({
    name,
    description,
    color: LABEL_COLORS[role],
    role,
  });

  return [
    define(L.plan, "human", "You set this: runs the wayfinder, produces a map and decision tickets"),
    define(L.planned, "gate", `Map ready: answer the decision tickets, then set ${L.approved}`),
    define(L.rework, "human", "You set this next to a state label: repeats that step, reading your comments"),
    define(L.approved, "human", "You set this at the gate: writes the ADRs on the plan branch"),
    define(L.toPrd, "machine", "Set by ASEL after the ADRs: writes the PRD on the plan branch"),
    define(L.specToApprove, "gate", `Gate: read the ADRs and the PRD, then set ${L.toPlan}`),
    define(L.toPlan, "human", "You set this at the gate: splits the plan into vertical slices"),
    define(L.planToApprove, "gate", `Gate: read the sliced plan, then set ${L.toTasks}`),
    define(L.toTasks, "human", "You set this at the gate: creates one issue per implementation task"),
    define(L.specced, "machine", "Planning done: the task issues exist and run on their own"),
    define(L.task, "task", "Implementation task: ASEL runs it in slice order on the plan branch"),
    define(L.fast, "human", "You set this: skips planning, implements straight away on its own branch"),
    define(L.inReview, "gate", "Run finished: review the commits, closing the issue is your call"),
    define(L.failed, "failure", "A run failed: read the newest ASEL comment, it says how to retry"),
    define(
      L.blocked,
      "blocked",
      `A run asked you a question: answer it in a comment, then set ${L.rework}`,
    ),
  ];
}

/**
 * Definition of one dynamic slice marker label. Not bootstrapped (the numbers
 * are unknown until a plan is sliced); the tasks run creates them, and the
 * colour lives here so every repository ends up with the same palette.
 */
export function sliceLabelDefinition(prefix: string, slice: number): LabelDefinition {
  return {
    name: sliceLabelFor(prefix, slice),
    description: `Marker only: this task belongs to slice ${slice} of its plan`,
    color: LABEL_COLORS.slice,
    role: "slice",
  };
}

export interface LabelBootstrapPlan {
  create: LabelDefinition[];
  /** Existing labels whose description no longer says what the label does. */
  update: Array<{ name: string; description: string }>;
}

/**
 * Pure diff between the labels a repository has and the ones it should have.
 * Names are compared case insensitively, because GitHub does not allow two
 * labels that differ only in case.
 */
export function planLabelBootstrap(
  existing: readonly RepoLabel[],
  desired: readonly LabelDefinition[],
): LabelBootstrapPlan {
  const byName = new Map(existing.map((label) => [label.name.toLowerCase(), label]));
  const plan: LabelBootstrapPlan = { create: [], update: [] };

  for (const definition of desired) {
    const current = byName.get(definition.name.toLowerCase());
    if (current === undefined) {
      plan.create.push(definition);
      continue;
    }
    if (current.description !== definition.description) {
      // Colour left alone on purpose, see the file header.
      plan.update.push({ name: current.name, description: definition.description });
    }
  }
  return plan;
}

/** The slice of the GitHub client this module needs. */
export interface LabelApi {
  listLabels(fullName: string): Promise<RepoLabel[]>;
  createLabel(fullName: string, label: { name: string; color: string; description: string }): Promise<void>;
  updateLabel(
    fullName: string,
    name: string,
    patch: { color?: string; description?: string },
  ): Promise<void>;
}

export interface LabelBootstrapReport {
  created: string[];
  updated: string[];
  /** Labels that could not be written, usually a token without label rights. */
  failed: string[];
}

/**
 * Makes sure a repository has every label of the state machine.
 *
 * Never throws: a token that may read issues but not write labels is a normal
 * setup, and it must not take the whole orchestrator down. Failures are logged
 * and reported, and the loop carries on.
 */
export async function ensureLabels(
  api: LabelApi,
  fullName: string,
  prefix: string,
  log: Logger,
): Promise<LabelBootstrapReport> {
  const report: LabelBootstrapReport = { created: [], updated: [], failed: [] };

  let existing: RepoLabel[];
  try {
    existing = await api.listLabels(fullName);
  } catch (error) {
    log.warn("cannot list labels, skipping bootstrap for this repository", {
      repo: fullName,
      error: (error as Error).message,
    });
    return report;
  }

  const plan = planLabelBootstrap(existing, labelDefinitions(prefix));

  for (const definition of plan.create) {
    try {
      await api.createLabel(fullName, {
        name: definition.name,
        color: definition.color,
        description: definition.description,
      });
      report.created.push(definition.name);
    } catch (error) {
      report.failed.push(definition.name);
      log.warn("cannot create label", {
        repo: fullName,
        label: definition.name,
        error: (error as Error).message,
      });
    }
  }

  for (const change of plan.update) {
    try {
      await api.updateLabel(fullName, change.name, { description: change.description });
      report.updated.push(change.name);
    } catch (error) {
      report.failed.push(change.name);
      log.warn("cannot update label description", {
        repo: fullName,
        label: change.name,
        error: (error as Error).message,
      });
    }
  }

  return report;
}
