import { describe, expect, test } from "vitest";
import { boxAt, cleanBoxes, overlap } from "./geometry.ts";

const box = (left: number, top: number, right: number, bottom: number) => ({
  left,
  top,
  right,
  bottom,
});
const found = (elementID: string, area: ReturnType<typeof box>, presence = 1) => ({
  elementID,
  box: area,
  confidence: null,
  presence,
});

describe("box geometry", () => {
  test("overlap is the shared area over the area covered together", () => {
    expect(overlap(box(0, 0, 1, 1), box(0, 0, 1, 1))).toBe(1);
    expect(overlap(box(0, 0, 0.5, 1), box(0.5, 0, 1, 1))).toBe(0);
    expect(overlap(box(0, 0, 0.5, 1), box(0.25, 0, 0.75, 1))).toBeCloseTo(1 / 3);
  });

  test("a point resolves to the smallest box under it", () => {
    const boxes = [found("window", box(0, 0, 1, 1)), found("button", box(0.4, 0.4, 0.6, 0.6))];
    expect(boxAt(boxes, { x: 0.5, y: 0.5 })?.elementID).toBe("button");
    expect(boxAt(boxes, { x: 0.1, y: 0.1 })?.elementID).toBe("window");
    expect(boxAt(boxes, { x: 1.5, y: 0.5 })).toBeNull();
  });

  test("drops slivers and keeps the surest of two contested boxes", () => {
    const kept = cleanBoxes([
      found("sliver", box(0.1, 0.1, 0.105, 0.5)),
      found("unsure", box(0.2, 0.2, 0.6, 0.6), 0.4),
      found("sure", box(0.21, 0.21, 0.61, 0.61), 0.9),
      found("apart", box(0.7, 0.7, 0.9, 0.9)),
    ]);
    expect(kept.map((item) => item.elementID)).toEqual(["sure", "apart"]);
  });
});
