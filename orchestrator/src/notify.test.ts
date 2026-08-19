import { describe, expect, it } from "vitest";
import { RUN_KINDS, labelUpdateAfterRun, labelsFor, type RunOutcome } from "./machine.js";
import { shouldNotifyOutcome } from "./notify.js";

const PREFIX = "asel";
const L = labelsFor(PREFIX);

const OUTCOMES: RunOutcome[] = ["success", "failure", "blocked"];

describe("shouldNotifyOutcome", () => {
  it("pushes when the process is stuck on a human", () => {
    expect(shouldNotifyOutcome("failure")).toBe(true);
    expect(shouldNotifyOutcome("blocked")).toBe(true);
  });

  it("stays silent on everything that moves by itself", () => {
    // A finished map, both spec gates and commits waiting for review all end as
    // a successful run. Woopy is an alarm, so none of them may buzz.
    expect(shouldNotifyOutcome("success")).toBe(false);
  });

  it("pushes exactly for the two labels that stop the pipeline", () => {
    for (const outcome of OUTCOMES) {
      for (const kind of RUN_KINDS) {
        const added = labelUpdateAfterRun(kind, outcome, PREFIX).add;
        const stopped = added.includes(L.failed) || added.includes(L.blocked);
        expect(shouldNotifyOutcome(outcome), `${kind}/${outcome}`).toBe(stopped);
      }
    }
  });
});
