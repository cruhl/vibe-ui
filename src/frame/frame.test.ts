import { describe, expect, test } from "vitest";
import { difference, seamDifference } from "./frame.ts";

const picture = (size: number, value: (i: number) => number) =>
  Uint8ClampedArray.from({ length: size }, (_, i) => value(i));

describe("seam difference", () => {
  const source = picture(576, (i) => 60 + ((i * 37) % 120));

  test("a continuation that starts on the same picture with its exposure shifted is no seam", () => {
    const darker = picture(576, (i) => (source[i] ?? 0) - 15);
    expect(difference(source, darker)).toBe(15);
    expect(seamDifference(source, darker)).toBe(0);
  });

  test("a cut to another picture or a black first frame still reads as a seam", () => {
    const other = picture(576, (i) => 60 + ((i * 91 + 50) % 120));
    const black = picture(576, () => 0);
    expect(seamDifference(source, other)).toBeGreaterThan(13);
    expect(seamDifference(source, black)).toBeGreaterThan(13);
  });

  test("a small change keeps its size, whichever thumbnail comes first", () => {
    const nudged = picture(576, (i) => (source[i] ?? 0) + (i % 2 === 0 ? 4 : -4));
    expect(seamDifference(source, nudged)).toBe(4);
    expect(seamDifference(nudged, source)).toBe(4);
    expect(seamDifference(new Uint8ClampedArray(), new Uint8ClampedArray())).toBe(0);
  });
});
