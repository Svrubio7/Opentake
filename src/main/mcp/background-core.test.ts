import { describe, expect, it, vi } from "vitest";
import { sessionGate } from "./background-core";

describe("background start", () => {
  it("a normal start registers the recording session at once, once", () => {
    const register = vi.fn();
    const s = sessionGate(false, register);
    expect(register).toHaveBeenCalledTimes(1);
    s.windowOpening();
    expect(register).toHaveBeenCalledTimes(1);
    expect(s.started).toBe(true);
  });

  it("a background start registers nothing until a window opens, then once", () => {
    const register = vi.fn();
    const s = sessionGate(true, register);
    expect(register).not.toHaveBeenCalled();
    expect(s.started).toBe(false);
    s.windowOpening();
    s.windowOpening();
    expect(register).toHaveBeenCalledTimes(1);
    expect(s.started).toBe(true);
  });
});
