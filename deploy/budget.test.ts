import { afterEach, describe, expect, test, vi } from "vitest";
import {
  Budget,
  blockOf,
  budgetRoute,
  busyCopy,
  estimateTokens,
  meteredAnswer,
  type Ceilings,
  type Metered,
} from "./budget.ts";

const tiny: Ceilings = {
  openAITokens: 1_000,
  blockTokens: 400,
  images: 2,
  jev: 3,
  reactorSeconds: 900,
};

function meter() {
  const stored = new Map<string, unknown>();
  const budget = new Budget({
    storage: {
      get: (key) => Promise.resolve(stored.get(key)),
      put: (key, value) => {
        stored.set(key, value);
        return Promise.resolve();
      },
    },
    blockConcurrencyWhile: (run) => run(),
  });
  const run = async (command: Record<string, unknown>) => {
    const response = await budget.fetch(
      new Request("https://budget/", { method: "POST", body: JSON.stringify(command) }),
    );
    const answer: unknown = await response.json();
    return answer;
  };
  const admit = (meterName: string, amount: number, block = "198.51.100.0/24", lease?: string) =>
    run({ kind: "admit", meter: meterName, amount, block, ceilings: tiny, lease });
  const charge = (tokens: number, block = "198.51.100.0/24") =>
    run({ kind: "charge", tokens, block });
  return { budget, run, admit, charge };
}

function environmentOf(budget: Budget, vars: Partial<Metered> = {}): Metered {
  const stub = { fetch: (request: Request) => budget.fetch(request) };
  return { BUDGET: { idFromName: () => "global", get: () => stub }, ...vars };
}

describe("Budget", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("admits OpenAI calls until today's tokens reach the ceiling", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-05T12:00:00Z") });
    const { admit, charge } = meter();
    expect(await admit("openai", 0, "a")).toEqual({ admitted: true });
    await charge(390, "a");
    await charge(390, "b");
    expect(await admit("openai", 0, "c")).toEqual({ admitted: true });
    await charge(220, "c");
    expect(await admit("openai", 0, "d")).toEqual({ admitted: false });
  });

  test("one block is refused at its own ceiling while others play on", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-05T12:00:00Z") });
    const { admit, charge } = meter();
    await charge(399, "a");
    expect(await admit("openai", 0, "a")).toEqual({ admitted: true });
    await charge(1, "a");
    expect(await admit("openai", 0, "a")).toEqual({ admitted: false });
    expect(await admit("openai", 0, "b")).toEqual({ admitted: true });
  });

  test("image and Jev calls are charged as admitted, and refused past the ceiling", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-05T12:00:00Z") });
    const { admit } = meter();
    expect(await admit("images", 1)).toEqual({ admitted: true });
    expect(await admit("images", 1)).toEqual({ admitted: true });
    expect(await admit("images", 1)).toEqual({ admitted: false });
    for (const _ of [1, 2, 3]) expect(await admit("jev", 1)).toEqual({ admitted: true });
    expect(await admit("jev", 1)).toEqual({ admitted: false });
  });

  test("a Reactor session is charged its capped seconds and refunded what it did not use", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-05T12:00:00Z") });
    const { admit, run } = meter();
    expect(await admit("reactor", 600, "a", "lease-1")).toEqual({ admitted: true });
    expect(await admit("reactor", 600, "a", "lease-2")).toEqual({ admitted: false });
    vi.advanceTimersByTime(100_000);
    expect(await run({ kind: "refund", lease: "lease-1" })).toEqual({ refunded: 500 });
    expect(await run({ kind: "refund", lease: "lease-1" })).toEqual({ refunded: 0 });
    expect(await admit("reactor", 600, "a", "lease-2")).toEqual({ admitted: true });
  });

  test("a new UTC day starts every meter at zero", async () => {
    vi.useFakeTimers({ now: Date.parse("2026-11-05T23:59:59Z") });
    const { admit, charge, run } = meter();
    await charge(1_000);
    await admit("images", 2);
    expect(await admit("openai", 0)).toEqual({ admitted: false });
    expect(await admit("images", 1)).toEqual({ admitted: false });
    vi.setSystemTime(Date.parse("2026-11-06T00:00:00Z"));
    expect(await admit("openai", 0)).toEqual({ admitted: true });
    expect(await admit("images", 1)).toEqual({ admitted: true });
    expect(await run({ kind: "report" })).toMatchObject({ day: "2026-11-06", openAITokens: 0 });
  });
});

describe("blockOf", () => {
  test("meters IPv4 by its /24 and IPv6 by its /48", () => {
    expect(blockOf("203.0.113.7")).toBe("203.0.113.0/24");
    expect(blockOf("2001:db8:85a3:12::/64")).toBe("2001:db8:85a3::/48");
    expect(blockOf("local")).toBe("local");
  });
});

describe("estimateTokens", () => {
  test("counts an inline image at a fixed cost and every other character as a token", () => {
    const text = JSON.stringify({
      input: "hello",
      image_url: `data:image/png;base64,${"A".repeat(9_000)}`,
    });
    const image = `data:image/png;base64,${"A".repeat(9_000)}`;
    expect(estimateTokens(text, 10)).toBe(1_500 + text.length - image.length + 10);
  });
});

const stream = (text: string) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode(text);
        controller.enqueue(bytes.slice(0, 17));
        controller.enqueue(bytes.slice(17));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );

describe("meteredAnswer", () => {
  test("passes the stream through and charges the usage it reports", async () => {
    vi.useRealTimers();
    const { budget, run } = meter();
    const environment = environmentOf(budget);
    const events = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":120,"output_tokens":30}}}\n\n',
    ].join("");
    const request = new Request("https://vibe-ui.test/api/openai/v1/responses", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.9" },
    });
    const waits: Promise<unknown>[] = [];
    const answer = meteredAnswer(environment, request, "{}", stream(events), {
      waitUntil: (promise) => waits.push(promise),
    });
    expect(await answer.text()).toBe(events);
    await Promise.all(waits);
    expect(await run({ kind: "report" })).toMatchObject({ openAITokens: 150, topBlocks: [150] });
  });

  test("charges the conservative estimate when the answer carries no usage", async () => {
    const { budget, run } = meter();
    const environment = environmentOf(budget);
    const events = 'data: {"type":"response.output_text.delta","delta":"abcdef"}\n\n';
    const request = new Request("https://vibe-ui.test/", { method: "POST" });
    const answer = meteredAnswer(environment, request, "x".repeat(40), stream(events), {
      waitUntil: () => undefined,
    });
    await answer.text();
    expect(await run({ kind: "report" })).toMatchObject({ openAITokens: 46 });
  });
});

describe("budgetRoute", () => {
  const secret = "budget-secret-0123456789";

  test("answers today's usage only with the secret header", async () => {
    const { budget } = meter();
    const environment = environmentOf(budget, { BUDGET_TOKEN: secret, DAILY_IMAGES: "7" });
    const ask = (headers: Record<string, string>) =>
      budgetRoute(environment, new Request("https://vibe-ui.test/api/budget", { headers }));
    expect((await ask({})).status).toBe(404);
    expect((await ask({ "X-Budget-Token": "wrong" })).status).toBe(404);
    const answer = await ask({ "X-Budget-Token": secret });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ images: 0, ceilings: { images: 7 } });
  });

  test("does not exist while the secret is unset", async () => {
    const { budget } = meter();
    const answer = await budgetRoute(
      environmentOf(budget),
      new Request("https://vibe-ui.test/api/budget", { headers: { "X-Budget-Token": "" } }),
    );
    expect(answer.status).toBe(404);
  });
});

test("the busy copy never names a provider", () => {
  expect(busyCopy).toBe("The demo is busy today. Try again tomorrow, or use your own API keys.");
});
