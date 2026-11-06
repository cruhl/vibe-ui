import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { BuildWatch, buildDeadlineMs, type BuildMiss } from "./build-watch.ts";

describe("BuildWatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () => {
    const misses: BuildMiss[] = [];
    const watch = new BuildWatch(
      (miss) => {
        misses.push(miss);
      },
      () => Date.now(),
    );
    return { watch, misses };
  };

  test("a build that never lands misses once, on a session that finished nothing: wedged", () => {
    const { watch, misses } = make();
    watch.watch("a", 1, 0);
    vi.advanceTimersByTime(buildDeadlineMs - 1);
    expect(misses).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(misses).toEqual([{ clipID: "a", slot: 1, milliseconds: buildDeadlineMs, wedged: true }]);
    expect(watch.watching("a")).toBe(false);
    vi.advanceTimersByTime(10 * buildDeadlineMs);
    expect(misses).toHaveLength(1);
  });

  test("a build that lands in time stops its deadline", () => {
    const { watch, misses } = make();
    watch.watch("a", 0, 0);
    vi.advanceTimersByTime(4500);
    watch.settle("a");
    watch.progressed(0);
    vi.advanceTimersByTime(10 * buildDeadlineMs);
    expect(misses).toEqual([]);
  });

  test("the deadline grows with the builds queued ahead on the session", () => {
    const { watch, misses } = make();
    watch.watch("a", 0, 0);
    watch.watch("b", 0, 1);
    vi.advanceTimersByTime(buildDeadlineMs);
    expect(misses.map((miss) => miss.clipID)).toEqual(["a"]);
    vi.advanceTimersByTime(buildDeadlineMs);
    expect(misses.map((miss) => miss.clipID)).toEqual(["a", "b"]);
    expect(misses[1]?.milliseconds).toBe(2 * buildDeadlineMs);
  });

  test("a session still finishing builds is slow, not wedged", () => {
    const { watch, misses } = make();
    watch.watch("a", 2, 3);
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(buildDeadlineMs);
      watch.progressed(2);
    }
    vi.advanceTimersByTime(buildDeadlineMs - 1000);
    watch.progressed(2);
    expect(misses).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(misses).toEqual([
      { clipID: "a", slot: 2, milliseconds: 4 * buildDeadlineMs, wedged: false },
    ]);
  });

  test("progress on one session does not clear another", () => {
    const { watch, misses } = make();
    watch.watch("a", 0, 0);
    vi.advanceTimersByTime(buildDeadlineMs - 1);
    watch.progressed(1);
    vi.advanceTimersByTime(1);
    expect(misses[0]?.wedged).toBe(true);
  });

  test("clear stops every deadline", () => {
    const { watch, misses } = make();
    watch.watch("a", 0, 0);
    watch.watch("b", 1, 0);
    watch.clear();
    vi.advanceTimersByTime(10 * buildDeadlineMs);
    expect(misses).toEqual([]);
  });
});
