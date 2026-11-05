import { describe, expect, it } from "vitest";
import { inputTimelines } from "./timeline.ts";

const miss = [
  { kind: "input", t: 10, inputID: "a", outcome: "miss", input: { kind: "click", label: "FIRE" } },
  { kind: "acknowledged", t: 10.02, inputID: null, clickT: 9.99, paintedT: 10.02, ms: 30 },
  { kind: "acknowledge_linked", t: 10.03, inputID: "a", ms: 30, paintedT: 10.02 },
  { kind: "phase", t: 10, inputID: "a", phase: "thinking" },
  { kind: "beat", t: 11, inputID: "a", text: "the fire grows" },
  { kind: "phase", t: 11, inputID: "a", phase: "writing" },
  { kind: "preview_shown", t: 12.5, inputID: "a", source: "fal", secondsFromClick: 2.5 },
  { kind: "clip_queued", t: 12.8, inputID: "a", clipID: "c1" },
  { kind: "clip_generated", t: 17, clipID: "c1" },
  { kind: "clip_started", t: 17.2, clipID: "c1" },
  { kind: "first_frame", t: 17.4, clipID: "c1" },
];

describe("inputTimelines", () => {
  it("reads every step of a miss and its phases", () => {
    const [timeline] = inputTimelines(miss);
    expect(timeline?.acknowledgeMs).toBe(30);
    expect(timeline?.beat).toBe("the fire grows");
    expect(timeline?.previewSource).toBe("fal");
    expect(timeline?.phaseStarts).toEqual({
      thinking: 10,
      writing: 11,
      filming: 12.8,
      arriving: 17,
    });
    expect(timeline?.phase).toBeNull();
  });

  it("is mid-phase until the first frame", () => {
    const [timeline] = inputTimelines(miss.slice(0, 8));
    expect(timeline?.phase).toBe("filming");
  });
});
