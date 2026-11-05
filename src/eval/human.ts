import type { Point } from "../boxes/index.ts";
import type { Box } from "../jev/index.ts";
import type { HumanTiming } from "./case.ts";

/** The delays of one action, in content milliseconds, and where the click really lands. */
export interface ActionPlan {
  reactionMs: number;
  readingMs: number;
  hesitationMs: number;
  travelMs: number;
  typingMs: number;
  idleMs: number;
  point: Point;
  misclicked: boolean;
}

/** A seeded human timing model: every draw comes from the case's parameters and seed. */
export class Human {
  private state: number;

  constructor(private readonly timing: HumanTiming) {
    this.state = timing.seed >>> 0 || 1;
  }

  private random(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  private normal(mean: number, sd: number): number {
    const u = Math.max(this.random(), 1e-9);
    const v = this.random();
    return Math.max(0, mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
  }

  private fitts(distance: number, width: number): number {
    return this.timing.fittsMs.a + this.timing.fittsMs.b * Math.log2(distance / width + 1);
  }

  /** Cursor travel time from one point to a target of this size, by Fitts' law. */
  travel(from: Point, to: Point, size: { width: number; height: number }): number {
    const width = Math.max(0.01, Math.min(size.width, size.height));
    return this.fitts(Math.hypot(to.x - from.x, to.y - from.y), width);
  }

  /** Time between looks while nothing calls for action. */
  glance(): number {
    return this.timing.glanceMs;
  }

  /**
   * Plans one action toward `target` from `from`: reaction, reading time for `wordsRead`, an
   * occasional hesitation or idle, Fitts travel by distance and target width, typing time, and a
   * misclick that moves the point off the target by the persona's spread.
   */
  plan(
    from: Point,
    target: Point,
    size: { width: number; height: number },
    wordsRead: number,
    typed: string,
  ): ActionPlan {
    const timing = this.timing;
    const misclicked = this.random() < timing.misclick.chance;
    const angle = this.random() * 2 * Math.PI;
    const point = misclicked
      ? {
          x: target.x + Math.cos(angle) * size.width * timing.misclick.spread,
          y: target.y + Math.sin(angle) * size.height * timing.misclick.spread,
        }
      : target;
    const distance = Math.hypot(point.x - from.x, point.y - from.y);
    const width = Math.max(0.01, Math.min(size.width, size.height));
    return {
      reactionMs: this.normal(timing.reactionMs.mean, timing.reactionMs.sd),
      readingMs: (Math.max(0, wordsRead) / timing.readingWordsPerMinute) * 60000,
      hesitationMs:
        this.random() < timing.hesitation.chance
          ? this.normal(timing.hesitation.ms.mean, timing.hesitation.ms.sd)
          : 0,
      travelMs: this.fitts(distance, width),
      typingMs: (typed.length / timing.typingCharsPerSecond) * 1000,
      idleMs:
        this.random() < timing.idle.chance
          ? this.normal(timing.idle.ms.mean, timing.idle.ms.sd)
          : 0,
      point: { x: Math.min(1, Math.max(0, point.x)), y: Math.min(1, Math.max(0, point.y)) },
      misclicked,
    };
  }
}

/** The center of a box and its size, in frame fractions. */
export function boxTarget(box: Box): { center: Point; size: { width: number; height: number } } {
  return {
    center: { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 },
    size: { width: box.right - box.left, height: box.bottom - box.top },
  };
}
