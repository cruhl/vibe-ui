import { describe, expect, test } from "vitest";
import { DeadlineError, retryOnce, withDeadline } from "./deadline.ts";
import { getEvents } from "./log.ts";

describe("withDeadline", () => {
  test("resolves a call that finishes in time", async () => {
    await expect(withDeadline("fast", 200, () => Promise.resolve(7))).resolves.toBe(7);
  });

  test("aborts, logs and rejects a call that misses", async () => {
    let aborted = false;
    const call = withDeadline(
      "slow",
      20,
      (signal) =>
        new Promise<number>(() => {
          signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    );
    await expect(call).rejects.toBeInstanceOf(DeadlineError);
    expect(aborted).toBe(true);
    expect(
      getEvents().some((event) => event.kind === "deadline_missed" && event.call === "slow"),
    ).toBe(true);
  });

  test("retryOnce runs a failed call exactly once more", async () => {
    let calls = 0;
    const result = retryOnce("flaky", () => {
      calls++;
      return calls === 1 ? Promise.reject(new Error("first")) : Promise.resolve("second");
    });
    await expect(result).resolves.toBe("second");
    expect(calls).toBe(2);
  });
});
