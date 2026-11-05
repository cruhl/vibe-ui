import { afterEach, describe, expect, test, vi } from "vitest";
import { networkOf, scrubbedFailure } from "./http.ts";
import { Sessions } from "./sessions.ts";

describe("networkOf", () => {
  test("keys an IPv6 address by its /64, however it is written", () => {
    expect(networkOf("2001:db8:85a3:12:8a2e:370:7334:1")).toBe("2001:db8:85a3:12::/64");
    expect(networkOf("2001:0db8:85a3:0012:ffff:ffff:ffff:ffff")).toBe("2001:db8:85a3:12::/64");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(networkOf("2001:DB8:0:0:1::")).toBe("2001:db8:0:0::/64");
    expect(networkOf("::1")).toBe("0:0:0:0::/64");
  });

  test("leaves an IPv4 address as it is", () => {
    expect(networkOf("203.0.113.7")).toBe("203.0.113.7");
    expect(networkOf("::ffff:203.0.113.7")).toBe("::ffff:203.0.113.7");
  });
});

describe("scrubbedFailure", () => {
  test("keeps the status and body but never a secret the Worker sent", async () => {
    const secret = "sk-test-0123456789abcdef";
    const upstream = new Response(`{"error":"bad key ${secret}, again ${secret}"}`, {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
    const answer = await scrubbedFailure(upstream, [secret]);
    expect(answer.status).toBe(401);
    expect(answer.headers.get("Content-Type")).toBe("application/json");
    expect(await answer.text()).toBe('{"error":"bad key [redacted], again [redacted]"}');
  });

  test("answers only the status for an empty or oversized body", async () => {
    const empty = await scrubbedFailure(new Response(null, { status: 503 }), ["secret-value"]);
    expect(await empty.text()).toBe("Upstream answered HTTP 503");
    const huge = await scrubbedFailure(new Response("x".repeat(64 * 1024), { status: 500 }), []);
    expect(await huge.text()).toBe("Upstream answered HTTP 500");
  });
});

function ledger() {
  const stored = new Map<string, unknown>();
  const sessions = new Sessions({
    storage: {
      get: (key) => Promise.resolve(stored.get(key)),
      put: (key, value) => {
        stored.set(key, value);
        return Promise.resolve();
      },
    },
    blockConcurrencyWhile: (run) => run(),
  });
  return async (command: Record<string, unknown>) => {
    const response = await sessions.fetch(
      new Request("https://sessions/", { method: "POST", body: JSON.stringify(command) }),
    );
    const answer: unknown = await response.json();
    return answer;
  };
}

describe("Sessions", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("an unbound lease stays counted while its token could still run a session", async () => {
    vi.useFakeTimers({ now: 0 });
    const run = ledger();
    const limits = { visitor: 2, global: 5, seconds: 600 };
    const acquire = () => run({ kind: "acquire", visitor: "a", limits });
    expect(await acquire()).toHaveProperty("lease");
    expect(await acquire()).toHaveProperty("lease");
    vi.setSystemTime(91_000);
    expect(await acquire()).toEqual({ refused: "visitor" });
    vi.setSystemTime((600 + 300 + 600) * 1000 - 1);
    expect(await acquire()).toEqual({ refused: "visitor" });
    vi.setSystemTime((600 + 300 + 600) * 1000);
    expect(await acquire()).toHaveProperty("lease");
  });

  test("a bound lease lasts its session, and ending it frees the place at once", async () => {
    vi.useFakeTimers({ now: 0 });
    const run = ledger();
    const limits = { visitor: 1, global: 5, seconds: 600 };
    const first = await run({ kind: "acquire", visitor: "a", limits });
    expect(first).toHaveProperty("lease");
    const lease =
      typeof first === "object" && first !== null && "lease" in first ? first.lease : "";
    await run({ kind: "bind", lease, visitor: "a", sessionID: "s1", seconds: 600 });
    vi.setSystemTime(629_000);
    expect(await run({ kind: "acquire", visitor: "a", limits })).toEqual({ refused: "visitor" });
    expect(await run({ kind: "release", lease, visitor: "a" })).toEqual({
      released: true,
      sessionID: "s1",
    });
    expect(await run({ kind: "acquire", visitor: "a", limits })).toHaveProperty("lease");
  });
});
