import { afterEach, describe, expect, test, vi } from "vitest";
import type { Environment } from "./http.ts";
import { logRoute, note, traced } from "./log.ts";

const openAIKey = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";

function environment(stored: Map<string, string>): Environment {
  const unused = {
    fetch: () => Promise.reject(new Error("unused")),
    idFromName: () => null,
    get: () => ({ fetch: () => Promise.reject(new Error("unused")) }),
  };
  const open = { limit: () => Promise.resolve({ success: true }) };
  return {
    ASSETS: unused,
    SESSIONS: unused,
    BUDGET: unused,
    PASSES: unused,
    WORLDS: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    LOGS: {
      put: (key, value) => {
        stored.set(key, value);
        return Promise.resolve();
      },
    },
    LIMIT_AGENT: open,
    LIMIT_JEV: open,
    LIMIT_FAL: open,
    LIMIT_SESSIONS: open,
    LIMIT_WORLDS: open,
    LIMIT_PASS: open,
    LIMIT_LOG: open,
    OPENAI_API_KEY: openAIKey,
    PASS_SECRET: "pass-secret-0123456789",
  };
}

function background() {
  const waits: Promise<unknown>[] = [];
  return {
    waitUntil: (promise: Promise<unknown>) => {
      waits.push(promise);
    },
    settled: () => Promise.all(waits),
  };
}

const request = (path: string, init: { headers?: Record<string, string>; body?: BodyInit } = {}) =>
  new Request(`https://vibe-ui.example${path}`, {
    method: "POST",
    body: init.body ?? null,
    headers: {
      Origin: "https://vibe-ui.example",
      "X-Vibe-Session": "2026-11-05T12-00-00-000Z-abc12345",
      "CF-Connecting-IP": "203.0.113.7",
      Cookie: "__Host-pass=secret-cookie-value",
      ...init.headers,
    },
  });

function captured(spy: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return spy.mock.calls.flatMap((call) => {
    const first = call[0];
    return typeof first === "object" && first !== null
      ? [Object.fromEntries(Object.entries(first))]
      : [];
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("traced", () => {
  test("logs one line per request with its notes and upstream calls, and no secret", async () => {
    const lines = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", () =>
      Promise.resolve(new Response(`{"error":"bad key ${openAIKey}"}`, { status: 401 })),
    );
    const stored = new Map<string, string>();
    const work = background();
    const answer = await traced(
      request("/api/openai/v1/responses"),
      environment(stored),
      work,
      async () => {
        note({ pass: "valid" });
        const upstream = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${openAIKey}` },
        });
        return new Response(await upstream.text(), { status: upstream.status });
      },
    );
    await work.settled();
    expect(answer.status).toBe(401);
    const [line] = captured(lines);
    expect(line).toMatchObject({
      log: "worker",
      route: "/api/openai/v1/responses",
      method: "POST",
      status: 401,
      session: "2026-11-05T12-00-00-000Z-abc12345",
      pass: "valid",
      upstream: [{ host: "api.openai.com", path: "/v1/responses", method: "POST", status: 401 }],
    });
    const text = JSON.stringify(line);
    expect(text).not.toContain(openAIKey);
    expect(text).not.toContain("secret-cookie-value");
    expect(text).not.toContain("203.0.113.7");
    expect(text).toContain("[redacted]");
    expect(stored.has("failing/2026-11-05T12-00-00-000Z-abc12345")).toBe(true);
  });

  test("logs an exception and answers 500", async () => {
    const lines = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const work = background();
    const answer = await traced(request("/api/budget"), environment(new Map()), work, () =>
      Promise.reject(new Error("boom")),
    );
    await work.settled();
    expect(answer.status).toBe(500);
    expect(captured(lines)[0]).toMatchObject({ status: 500, exception: { message: "boom" } });
  });
});

async function gzip(text: string): Promise<ArrayBuffer> {
  return new Response(
    new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
  ).arrayBuffer();
}

describe("logRoute", () => {
  test("keeps a gzip batch in R2 by session, scrubbed, and marks a failing session", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const stored = new Map<string, string>();
    const batch = {
      session: "run-1",
      sequence: 3,
      failed: ["agent_failed"],
      events: [
        { kind: "agent_call_start", t: 1.5, at: "2026-11-05T12:00:01Z" },
        { kind: "agent_failed", t: 2, detail: `leaked ${openAIKey}` },
      ],
    };
    const work = background();
    const answer = await logRoute(
      environment(stored),
      request("/api/log", {
        headers: { "Content-Type": "application/gzip" },
        body: await gzip(JSON.stringify(batch)),
      }),
      work,
    );
    await work.settled();
    expect(answer.status).toBe(204);
    const kept = stored.get("sessions/run-1/000003.jsonl") ?? "";
    expect(kept.trim().split("\n")).toHaveLength(2);
    expect(kept).not.toContain(openAIKey);
    expect(stored.get("failing/run-1")).toContain("agent_failed");
  });

  test("refuses what is not a run-log batch", async () => {
    const stored = new Map<string, string>();
    const plain = await logRoute(
      environment(stored),
      request("/api/log", { headers: { "Content-Type": "text/plain" }, body: "hello" }),
      background(),
    );
    expect(plain.status).toBe(415);
    const wrong = await logRoute(
      environment(stored),
      request("/api/log", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session: "../etc", sequence: 0, failed: [], events: [] }),
      }),
      background(),
    );
    expect(wrong.status).toBe(400);
    expect(stored.size).toBe(0);
  });
});
