import { afterEach, describe, expect, test, vi } from "vitest";
import type { Environment } from "./http.ts";
import { Passes, passRoute, passValid, requirePass, signPass } from "./pass.ts";

const secret = "s".repeat(48);
const origin = "https://vibe-ui.example.workers.dev";

function ledger(): Environment["PASSES"] {
  const stored = new Map<string, unknown>();
  const passes = new Passes({
    storage: {
      get: (key) => Promise.resolve(stored.get(key)),
      put: (key, value) => {
        stored.set(key, value);
        return Promise.resolve();
      },
    },
    blockConcurrencyWhile: (run) => run(),
  });
  return { idFromName: () => null, get: () => passes };
}

function environment(passes = ledger()): Environment {
  const unused = {
    fetch: () => Promise.reject(new Error("unused")),
    idFromName: () => null,
    get: () => ({ fetch: () => Promise.reject(new Error("unused")) }),
    put: () => Promise.resolve(),
  };
  const open = { limit: () => Promise.resolve({ success: true }) };
  return {
    ASSETS: unused,
    SESSIONS: unused,
    BUDGET: unused,
    PASSES: passes,
    WORLDS: { get: () => Promise.resolve(null), put: () => Promise.resolve() },
    LIMIT_AGENT: open,
    LIMIT_JEV: open,
    LIMIT_FAL: open,
    LIMIT_SESSIONS: open,
    LIMIT_WORLDS: open,
    LIMIT_PASS: open,
    LIMIT_LOG: open,
    LOGS: unused,
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    PASS_SECRET: secret,
  };
}

function request(path: string, headers: Record<string, string>, body?: unknown): Request {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, ...headers },
    body: JSON.stringify(body ?? {}),
  });
}

describe("passValid", () => {
  test("holds for its own network until it expires, and never for another", async () => {
    const now = 1_000_000;
    const pass = await signPass(secret, "203.0.113.7", now + 60_000);
    expect(await passValid(secret, "203.0.113.7", pass, now)).toBe(true);
    expect(await passValid(secret, "203.0.113.8", pass, now)).toBe(false);
    expect(await passValid(secret, "203.0.113.7", pass, now + 60_000)).toBe(false);
    expect(await passValid("t".repeat(48), "203.0.113.7", pass, now)).toBe(false);
  });

  test("refuses a tampered, malformed or too long-lived pass", async () => {
    const now = 1_000_000;
    const pass = await signPass(secret, "a", now + 60_000);
    const [stamp = "", signature = ""] = pass.split(".");
    expect(await passValid(secret, "a", `${String(Number(stamp) + 1)}.${signature}`, now)).toBe(
      false,
    );
    expect(await passValid(secret, "a", `${stamp}.${signature.slice(1)}x`, now)).toBe(false);
    expect(await passValid(secret, "a", "garbage", now)).toBe(false);
    const forever = await signPass(secret, "a", now + 24 * 60 * 60_000);
    expect(await passValid(secret, "a", forever, now)).toBe(false);
  });
});

describe("passRoute", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sent: unknown[] = [];
  const verdict = (value: unknown) =>
    vi.fn((_url: string, init: RequestInit) => {
      sent.push(typeof init.body === "string" ? JSON.parse(init.body) : null);
      return Promise.resolve(new Response(JSON.stringify(value), { status: 200 }));
    });

  test("trades a passing token for a signed HttpOnly cookie that the gate then accepts", async () => {
    const siteverify = verdict({
      success: true,
      hostname: "vibe-ui.example.workers.dev",
      action: "hosted",
    });
    vi.stubGlobal("fetch", siteverify);
    const headers = { "CF-Connecting-IP": "2001:db8:1:2:3:4:5:6" };
    const answer = await passRoute(environment(), request("/api/pass", headers, { token: "t" }));
    expect(answer.status).toBe(200);
    const cookie = answer.headers.get("Set-Cookie") ?? "";
    expect(cookie).toMatch(
      /^__Host-vibe-pass=\d+\.[\w-]{43}; Max-Age=900; Path=\/; HttpOnly; Secure; SameSite=Strict$/,
    );
    expect(sent.at(-1)).toEqual({
      secret: "turnstile-secret",
      response: "t",
      remoteip: "2001:db8:1:2:3:4:5:6",
    });
    const value = cookie.split(";")[0] ?? "";
    const sameNetwork = { Cookie: value, "CF-Connecting-IP": "2001:db8:1:2:ffff::1" };
    expect(await requirePass(environment(), request("/api/fal/x", sameNetwork))).toBeNull();
    const otherNetwork = { Cookie: value, "CF-Connecting-IP": "2001:db8:1:3::1" };
    const refused = await requirePass(environment(), request("/api/fal/x", otherNetwork));
    expect(refused?.status).toBe(403);
    expect(refused?.headers.get("X-Pass")).toBe("required");
  });

  test("refuses a replayed or expired token, another site's, or another action's", async () => {
    const refusals = [
      { success: false, "error-codes": ["timeout-or-duplicate"] },
      { success: true, hostname: "elsewhere.example", action: "hosted" },
      { success: true, hostname: "vibe-ui.example.workers.dev", action: "login" },
    ];
    for (const refusal of refusals) {
      vi.stubGlobal("fetch", verdict(refusal));
      const answer = await passRoute(environment(), request("/api/pass", {}, { token: "t" }));
      expect(answer.status).toBe(403);
      expect(answer.headers.get("Set-Cookie")).toBeNull();
    }
  });

  test("spends a token once, even when siteverify would pass it again", async () => {
    vi.stubGlobal(
      "fetch",
      verdict({ success: true, hostname: "vibe-ui.example.workers.dev", action: "hosted" }),
    );
    const shared = environment();
    const trade = () => passRoute(shared, request("/api/pass", {}, { token: "replayed" }));
    expect((await trade()).status).toBe(200);
    const replay = await trade();
    expect(replay.status).toBe(403);
    expect(replay.headers.get("Set-Cookie")).toBeNull();
  });

  test("issues nothing and passes nothing when the secrets are unset", async () => {
    const bare = { ...environment(), PASS_SECRET: undefined };
    expect((await passRoute(bare, request("/api/pass", {}, { token: "t" }))).status).toBe(503);
    const pass = await signPass(secret, "local", Date.now() + 60_000);
    const answer = await requirePass(
      bare,
      request("/api/jev/x", { Cookie: `__Host-vibe-pass=${pass}` }),
    );
    expect(answer?.status).toBe(403);
  });
});
