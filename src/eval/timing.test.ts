import { describe, expect, it } from "vitest";
import { checkTiming } from "./timing.ts";

const deadlines = {
  firstClipSeconds: 10,
  clickToFirstFrameSeconds: 5,
  maxHoldSeconds: 2,
  maxBlackFrames: 0,
  readySeconds: 30,
};

const run = (clickFrameAt: number) => [
  { kind: "run_start", t: 0 },
  { kind: "first_frame", t: 4, clipID: "a" },
  { kind: "input", t: 10, inputID: "i1", input: { kind: "click", label: "FIRE" }, outcome: "miss" },
  { kind: "first_frame", t: clickFrameAt, clipID: "b" },
  { kind: "first_changed_frame", t: clickFrameAt, clipID: "b" },
  { kind: "run_end", t: 30 },
];

describe("checkTiming", () => {
  it("passes a run inside every deadline", () => {
    const report = checkTiming(run(13), deadlines);
    expect(report.ok).toBe(true);
    expect(report.inputs[0]?.clickToFirstFrame).toBe(3);
    expect(report.inputs[0]?.speculated).toBe(false);
  });

  it("fails a late first frame and a black frame", () => {
    const report = checkTiming([...run(17), { kind: "black_frame", t: 18 }], deadlines);
    expect(report.ok).toBe(false);
    expect(report.checks.filter((check) => !check.ok).map((check) => check.name)).toEqual([
      "click to first frame",
      "black frames",
    ]);
  });

  it("ignores events after run_end", () => {
    const report = checkTiming([...run(13), { kind: "stall", t: 31 }], deadlines);
    expect(report.ok).toBe(true);
  });

  it("counts a hold from the next clip's build, never the wait on it", () => {
    const clips = (startedAt: number) => [
      { kind: "run_start", t: 0 },
      { kind: "first_frame", t: 4, clipID: "a" },
      { kind: "clip_queued", t: 9.9, clipID: "b" },
      { kind: "clip_finished", t: 10, clipID: "a" },
      { kind: "clip_generated", t: 13.3, clipID: "b" },
      { kind: "clip_started", t: startedAt, clipID: "b" },
      { kind: "run_end", t: 30 },
    ];
    expect(checkTiming(clips(13.5), deadlines).holds).toEqual([{ clipID: "b", seconds: 0.2 }]);
    expect(checkTiming(clips(16), deadlines).holds).toEqual([{ clipID: "b", seconds: 2.7 }]);
  });
});
