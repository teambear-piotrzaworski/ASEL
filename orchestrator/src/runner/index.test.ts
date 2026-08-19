import { describe, expect, it } from "vitest";
import { optionalPositiveInt, resolveContainerUser } from "./index.js";

describe("optionalPositiveInt", () => {
  it("reads a positive integer", () => {
    expect(optionalPositiveInt("1000")).toBe(1000);
    expect(optionalPositiveInt(" 501 ")).toBe(501);
  });

  it("rejects everything that is not one", () => {
    expect(optionalPositiveInt(undefined)).toBeUndefined();
    expect(optionalPositiveInt("")).toBeUndefined();
    expect(optionalPositiveInt("   ")).toBeUndefined();
    expect(optionalPositiveInt("agent")).toBeUndefined();
    expect(optionalPositiveInt("10.5")).toBeUndefined();
    expect(optionalPositiveInt("-1")).toBeUndefined();
  });

  it("rejects zero, which is root", () => {
    expect(optionalPositiveInt("0")).toBeUndefined();
  });
});

describe("resolveContainerUser", () => {
  it("takes the pair the host exported", () => {
    expect(resolveContainerUser({ ASEL_AGENT_UID: "501", ASEL_AGENT_GID: "20" })).toEqual({
      uid: 501,
      gid: 20,
    });
  });

  it("falls back to the sandcastle default when neither is set", () => {
    expect(resolveContainerUser({})).toBeUndefined();
  });

  // Half an answer would run the agent as <host uid>:0 and leave root owned
  // groups on every file it writes into the bind mounted worktree.
  it("refuses half a pair", () => {
    expect(resolveContainerUser({ ASEL_AGENT_UID: "501" })).toBeUndefined();
    expect(resolveContainerUser({ ASEL_AGENT_GID: "20" })).toBeUndefined();
  });

  it("refuses a pair that is not two positive integers", () => {
    expect(resolveContainerUser({ ASEL_AGENT_UID: "0", ASEL_AGENT_GID: "0" })).toBeUndefined();
    expect(resolveContainerUser({ ASEL_AGENT_UID: "agent", ASEL_AGENT_GID: "20" })).toBeUndefined();
    expect(resolveContainerUser({ ASEL_AGENT_UID: "501", ASEL_AGENT_GID: "" })).toBeUndefined();
  });
});
