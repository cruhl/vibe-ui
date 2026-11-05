import { describe, expect, test } from "vitest";
import { heldVerdict, momentChecks } from "./checks.ts";

const found = (elementID: string, presence: number) => ({
  elementID,
  box: { left: 0, top: 0, right: 0.5, bottom: 0.5 },
  confidence: null,
  presence,
});
const result = (boxes: ReturnType<typeof found>[], degradation: number | null) => ({
  boxes,
  likelihoods: null,
  degradation,
  inputTokens: 0,
  model: "test",
  questions: {},
  answers: {},
});

describe("held frame checks", () => {
  test("passes when what is shown, added and removed matches", () => {
    const boxes = [found("door", 1), found("lamp", 0.5)];
    const verdict = heldVerdict(
      { introduced: ["lamp"], removed: [{ id: "ghost" }] },
      boxes,
      [...boxes, found("ghost", 0.1)],
      0,
    );
    expect(verdict).toEqual({
      presence: 0.75,
      introducedPresence: 0.5,
      lingering: 0.1,
      passed: true,
    });
  });

  test("fails on a missing addition, a lingering removal or a degraded picture", () => {
    const boxes = [found("door", 0.9)];
    expect(heldVerdict({ introduced: ["lamp"], removed: [] }, boxes, boxes, 0).passed).toBe(false);
    expect(
      heldVerdict({ introduced: [], removed: [{ id: "ghost" }] }, boxes, [found("ghost", 0.9)], 0)
        .passed,
    ).toBe(false);
    expect(heldVerdict({ introduced: [], removed: [] }, boxes, boxes, 2).passed).toBe(false);
  });

  test("a latent start fails past the seam limit and a pinned one never does on its seam", () => {
    const boxes = [found("door", 0.9)];
    const expected = { introduced: [], removed: [] };
    const answer = result(boxes, 0.004);
    expect(momentChecks({ ...expected, start: "latent" }, boxes, answer, 20).passed).toBe(false);
    expect(momentChecks({ ...expected, start: "pinned" }, boxes, answer, 20).passed).toBe(true);
    expect(momentChecks({ ...expected, start: "latent" }, boxes, answer, 4.44)).toEqual({
      presence: 0.9,
      introducedPresence: null,
      lingering: null,
      degradation: 0,
      seam: 4.4,
      passed: true,
    });
  });
});
