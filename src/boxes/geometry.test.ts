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

  test("a field's box wins over every other box under the point, however small they are", () => {
    const boxes = [
      found("window", box(0, 0, 1, 1)),
      found("field", box(0.2, 0.7, 0.8, 0.9)),
      found("send", box(0.7, 0.75, 0.78, 0.85)),
      found("megaphone", box(0.3, 0.5, 0.5, 0.8)),
    ];
    const takesTyping = (item: { elementID: string }) => item.elementID === "field";
    expect(boxAt(boxes, { x: 0.74, y: 0.8 }, takesTyping)?.elementID).toBe("field");
    expect(boxAt(boxes, { x: 0.4, y: 0.75 }, takesTyping)?.elementID).toBe("field");
    expect(boxAt(boxes, { x: 0.21, y: 0.71 }, takesTyping)?.elementID).toBe("field");
    expect(boxAt(boxes, { x: 0.4, y: 0.6 }, takesTyping)?.elementID).toBe("megaphone");
    expect(boxAt(boxes, { x: 0.1, y: 0.1 }, takesTyping)?.elementID).toBe("window");
    expect(boxAt(boxes, { x: 0.74, y: 0.8 })?.elementID).toBe("send");
  });

  test("of two fields under a point, the smaller wins", () => {
    const boxes = [found("outer", box(0, 0.5, 1, 1)), found("inner", box(0.4, 0.6, 0.6, 0.7))];
    expect(boxAt(boxes, { x: 0.5, y: 0.65 }, () => true)?.elementID).toBe("inner");
  });

  test("a field's box survives a contest with a surer pick over the same spot", () => {
    const kept = cleanBoxes(
      [found("pick", box(0.2, 0.7, 0.8, 0.9), 0.99), found("field", box(0.21, 0.7, 0.8, 0.9), 0.6)],
      (item) => item.elementID === "field",
    );
    expect(kept.map((item) => item.elementID)).toEqual(["field"]);
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
