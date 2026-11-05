import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { InputLock } from "./lock.ts";

describe("InputLock", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const make = () => {
    const misses: [string, number][] = [];
    const lock = new InputLock<string>(
      (inputID, milliseconds) => {
        misses.push([inputID, milliseconds]);
      },
      () => Date.now(),
    );
    return { lock, misses };
  };

  test("a missed deadline reports the locked input once, counted from the lock", () => {
    const { lock, misses } = make();
    lock.lock("a", 10000);
    vi.advanceTimersByTime(9999);
    expect(misses).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(misses).toEqual([["a", 10000]]);
    vi.advanceTimersByTime(60000);
    expect(misses).toEqual([["a", 10000]]);
  });

  test("unlocking in time stops the deadline", () => {
    const { lock, misses } = make();
    lock.lock("a", 10000);
    vi.advanceTimersByTime(5000);
    expect(lock.unlock()).toBe("a");
    expect(lock.inputID).toBeNull();
    vi.advanceTimersByTime(60000);
    expect(misses).toEqual([]);
  });

  test("a new lock replaces the old one and its deadline", () => {
    const { lock, misses } = make();
    lock.lock("a", 10000);
    vi.advanceTimersByTime(8000);
    lock.lock("b", 10000);
    vi.advanceTimersByTime(8000);
    expect(misses).toEqual([]);
    vi.advanceTimersByTime(2000);
    expect(misses).toEqual([["b", 10000]]);
  });

  test("a pause stops the clock and a resume keeps only the time that was left", () => {
    const { lock, misses } = make();
    lock.lock("a", 10000);
    vi.advanceTimersByTime(4000);
    lock.suspend();
    vi.advanceTimersByTime(60000);
    expect(misses).toEqual([]);
    lock.resume();
    vi.advanceTimersByTime(5999);
    expect(misses).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(misses).toEqual([["a", 10000]]);
  });

  test("only the last refused input is kept, and the one it replaces is returned", () => {
    const { lock } = make();
    lock.lock("a", 10000);
    expect(lock.hold("first")).toBeNull();
    expect(lock.hold("second")).toBe("first");
    lock.unlock();
    expect(lock.takeHeld()).toBe("second");
    expect(lock.takeHeld()).toBeNull();
  });
});
