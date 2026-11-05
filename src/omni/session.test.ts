import { afterEach, describe, expect, test, vi } from "vitest";
import { terminateSession } from "./session.ts";

describe("terminateSession", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const answering = (statuses: (number | "network")[]) => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      if (!url.startsWith("https://api.reactor.inc/")) return Promise.resolve(new Response("{}"));
      calls.push(`${init.method ?? "GET"} ${url}`);
      const status = statuses[calls.length - 1] ?? 200;
      return status === "network"
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(new Response("{}", { status }));
    });
    return calls;
  };

  test("retries a contended and a failed close until the server confirms", async () => {
    vi.useFakeTimers();
    const calls = answering([409, 500, 200]);
    const result = terminateSession("key", "abc");
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ terminated: true, attempts: 3, status: 200 });
    expect(calls).toEqual(Array(3).fill("DELETE https://api.reactor.inc/sessions/abc"));
  });

  test("retries a network failure and gives up after a bounded number of attempts", async () => {
    vi.useFakeTimers();
    const calls = answering(["network", "network", "network", 200]);
    const result = terminateSession("key", "abc");
    await vi.runAllTimersAsync();
    expect(await result).toEqual({ terminated: false, attempts: 3, status: null });
    expect(calls.length).toBe(3);
  });

  test("does not retry a refusal that a retry cannot fix", async () => {
    const calls = answering([403]);
    expect(await terminateSession("key", "abc")).toEqual({
      terminated: false,
      attempts: 1,
      status: 403,
    });
    expect(calls.length).toBe(1);
  });
});
