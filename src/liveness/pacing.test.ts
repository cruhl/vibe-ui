import { describe, expect, it } from "vitest";
import { medianPhaseSeconds, phaseDurations } from "./pacing.ts";

describe("pacing", () => {
  it("paces from the median of measured phases", () => {
    const durations = phaseDurations(
      { thinking: 10, writing: 11, filming: 12.8, arriving: 17 },
      17.4,
    );
    expect(durations.filming).toBeCloseTo(4.2);
    expect(durations.arriving).toBeCloseTo(0.4);
    expect(medianPhaseSeconds([durations]).filming).toBeCloseTo(4.2);
    expect(medianPhaseSeconds([]).filming).toBe(4.5);
  });

  it("leaves out a phase that never began", () => {
    expect(
      phaseDurations({ thinking: 10, writing: null, filming: 12, arriving: 16 }, 16.5),
    ).toEqual({ filming: 4, arriving: 0.5 });
  });
});
