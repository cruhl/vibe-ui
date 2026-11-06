import type { Box, ElementBox } from "../jev/index.ts";
import { record } from "../run-log/index.ts";

/** A point on the frame, in fractions of its width and height. */
export interface Point {
  x: number;
  y: number;
}

/** A box narrower or shorter than this, in frame fractions, cannot be hit. */
const minimumBoxSide = 0.01;
/** Two boxes whose overlap passes this share of their union contest the same spot. */
const contestedOverlap = 0.6;

export const area = (box: Box) => (box.right - box.left) * (box.bottom - box.top);

/** Whether a point lies inside a box, edges included. */
export const contains = (box: Box, point: Point) =>
  point.x >= box.left && point.x <= box.right && point.y >= box.top && point.y <= box.bottom;

/** How much two boxes overlap: the shared area over the area they cover together. */
export function overlap(first: Box, second: Box): number {
  const width = Math.min(first.right, second.right) - Math.max(first.left, second.left);
  const height = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
  if (width <= 0 || height <= 0) return 0;
  const shared = width * height;
  return shared / (area(first) + area(second) - shared);
}

/**
 * The box a click at a point lands on, the one rule that resolves a click among overlapping
 * boxes: a box that takes typing wins over every other box under the point, so a click anywhere
 * on a field opens typing on it; among the rest, the smallest box wins.
 */
export function boxAt<Found extends { box: Box }>(
  boxes: readonly Found[],
  point: Point,
  takesTyping: (found: Found) => boolean = () => false,
): Found | null {
  const rank = (found: Found) => (takesTyping(found) ? 0 : 1);
  return (
    boxes
      .filter((found) => contains(found.box, point))
      .sort(
        (first, second) => rank(first) - rank(second) || area(first.box) - area(second.box),
      )[0] ?? null
  );
}

/**
 * A box of the given width and height centered on a point, all in frame fractions, shifted
 * inward where it would cross an edge so it keeps its size.
 */
export function boxAround(point: Point, width: number, height: number): Box {
  const left = Math.min(Math.max(point.x - width / 2, 0), Math.max(0, 1 - width));
  const top = Math.min(Math.max(point.y - height / 2, 0), Math.max(0, 1 - height));
  return { left, top, right: Math.min(1, left + width), bottom: Math.min(1, top + height) };
}

/**
 * Boxes that can be hit: drops boxes with no real width or height, and where two elements' boxes
 * mostly cover each other keeps only one: a box that takes typing over one that does not,
 * otherwise the one Jev is surest of. Logs `boxes_dropped`.
 */
export function cleanBoxes(
  boxes: readonly ElementBox[],
  takesTyping: (found: ElementBox) => boolean = () => false,
): ElementBox[] {
  const sized = boxes.filter(
    (found) =>
      found.box.right - found.box.left >= minimumBoxSide &&
      found.box.bottom - found.box.top >= minimumBoxSide,
  );
  const sureness = (found: ElementBox) => found.presence * (found.confidence ?? 1);
  const beats = (other: ElementBox, found: ElementBox) =>
    takesTyping(other) !== takesTyping(found)
      ? takesTyping(other)
      : sureness(other) > sureness(found) ||
        (sureness(other) === sureness(found) && sized.indexOf(other) < sized.indexOf(found));
  const kept = sized.filter(
    (found) =>
      !sized.some(
        (other) =>
          other !== found &&
          overlap(found.box, other.box) > contestedOverlap &&
          beats(other, found),
      ),
  );
  if (kept.length < boxes.length)
    record("boxes_dropped", {
      dropped: boxes.filter((found) => !kept.includes(found)).map((found) => found.elementID),
    });
  return kept;
}
