import { z } from "zod";
import { count, json, reply, visitorOf, type Background, type Environment } from "./http.ts";
import { note } from "./log.ts";

/** The part of a deployment the budget reads: its meter, its ceilings and the owner's secret. */
export type Metered = Pick<
  Environment,
  | "BUDGET"
  | "DAILY_OPENAI_TOKENS"
  | "DAILY_BLOCK_TOKENS"
  | "DAILY_IMAGES"
  | "DAILY_JEV"
  | "DAILY_REACTOR_SECONDS"
  | "BUDGET_TOKEN"
>;

/** What a visitor is told once today's budget for a hosted route is gone. */
export const busyCopy = "The demo is busy today. Try again tomorrow, or use your own API keys.";

/** The daily ceilings of a deployment, from its vars. */
export interface Ceilings {
  openAITokens: number;
  blockTokens: number;
  images: number;
  jev: number;
  reactorSeconds: number;
}

/** The daily ceilings a deployment's vars set, with the defaults for any left unset. */
export function ceilings(environment: Metered): Ceilings {
  return {
    openAITokens: count(environment.DAILY_OPENAI_TOKENS, 40_000_000),
    blockTokens: count(environment.DAILY_BLOCK_TOKENS, 4_000_000),
    images: count(environment.DAILY_IMAGES, 3_000),
    jev: count(environment.DAILY_JEV, 20_000),
    reactorSeconds: count(environment.DAILY_REACTOR_SECONDS, 72_000),
  };
}

/**
 * The address block one client is metered by: an IPv4 address by its /24 and an IPv6 one by its
 * /48, the most a single site or scripted host commonly holds.
 */
export function blockOf(address: string): string {
  if (address.includes(".") && !address.includes(":"))
    return `${address.split(".").slice(0, 3).join(".")}.0/24`;
  const network = address.match(/^([^:]+):([^:]+):([^:]+):[^:]+::\/64$/);
  return network === null ? address : `${network[1]}:${network[2]}:${network[3]}::/48`;
}

const Command = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("admit"),
    meter: z.enum(["openai", "images", "jev", "reactor"]),
    amount: z.number().nonnegative(),
    block: z.string(),
    lease: z.string().optional(),
    ceilings: z.object({
      openAITokens: z.number(),
      blockTokens: z.number(),
      images: z.number(),
      jev: z.number(),
      reactorSeconds: z.number(),
    }),
  }),
  z.object({ kind: z.literal("charge"), tokens: z.number().nonnegative(), block: z.string() }),
  z.object({ kind: z.literal("refund"), lease: z.string() }),
  z.object({ kind: z.literal("report") }),
]);
type Command = z.infer<typeof Command>;

const Day = z.object({
  day: z.string(),
  openAITokens: z.number(),
  images: z.number(),
  jev: z.number(),
  reactorSeconds: z.number(),
  blocks: z.record(z.string(), z.number()),
  leases: z.record(z.string(), z.object({ at: z.number(), seconds: z.number() })),
});
type Day = z.infer<typeof Day>;

interface DurableObjectState {
  storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
}

const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

const emptyDay = (day: string): Day => ({
  day,
  openAITokens: 0,
  images: 0,
  jev: 0,
  reactorSeconds: 0,
  blocks: {},
  leases: {},
});

/**
 * The one meter of hosted spend per UTC day, a single Durable Object every metered request goes
 * through, so counts never race. OpenAI tokens are admitted while today's total and the client's
 * block are under their ceilings, and charged once the answer's usage is known; an image call, a
 * Jev call or a Reactor session's capped seconds are charged as they are admitted, and a session
 * ended early is refunded what it did not use. A new UTC day starts every meter at zero.
 */
export class Budget {
  private today: Day = emptyDay("");

  constructor(private readonly state: DurableObjectState) {
    void state.blockConcurrencyWhile(async () => {
      const parsed = Day.safeParse(await state.storage.get("day"));
      if (parsed.success) this.today = parsed.data;
    });
  }

  async fetch(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    const parsed = Command.safeParse(body);
    if (!parsed.success) return json(400, { error: "bad command" });
    const answer = this.run(parsed.data, Date.now());
    await this.state.storage.put("day", this.today);
    return json(200, answer);
  }

  private run(command: Command, now: number): unknown {
    if (this.today.day !== dayOf(now)) this.today = emptyDay(dayOf(now));
    const today = this.today;
    switch (command.kind) {
      case "admit": {
        const limits = command.ceilings;
        if (command.meter === "openai") {
          const used = today.blocks[command.block] ?? 0;
          return {
            admitted: today.openAITokens < limits.openAITokens && used < limits.blockTokens,
          };
        }
        const used = {
          images: today.images,
          jev: today.jev,
          reactor: today.reactorSeconds,
        }[command.meter];
        const ceiling = {
          images: limits.images,
          jev: limits.jev,
          reactor: limits.reactorSeconds,
        }[command.meter];
        if (used + command.amount > ceiling) return { admitted: false };
        if (command.meter === "images") today.images += command.amount;
        if (command.meter === "jev") today.jev += command.amount;
        if (command.meter === "reactor") {
          today.reactorSeconds += command.amount;
          if (command.lease !== undefined)
            today.leases[command.lease] = { at: now, seconds: command.amount };
        }
        return { admitted: true };
      }
      case "charge": {
        const tokens = Math.ceil(command.tokens);
        today.openAITokens += tokens;
        today.blocks[command.block] = (today.blocks[command.block] ?? 0) + tokens;
        return { charged: tokens };
      }
      case "refund": {
        const lease = today.leases[command.lease];
        if (lease === undefined) return { refunded: 0 };
        const unused = Math.max(0, lease.seconds - Math.ceil((now - lease.at) / 1000));
        today.reactorSeconds -= unused;
        today.leases = Object.fromEntries(
          Object.entries(today.leases).filter(([id]) => id !== command.lease),
        );
        return { refunded: unused };
      }
      case "report": {
        const blocks = Object.entries(today.blocks).sort(([, a], [, b]) => b - a);
        return {
          day: today.day,
          openAITokens: today.openAITokens,
          images: today.images,
          jev: today.jev,
          reactorSeconds: today.reactorSeconds,
          blocks: blocks.length,
          topBlocks: blocks.slice(0, 5).map(([, tokens]) => tokens),
        };
      }
    }
  }
}

async function meter<T>(environment: Metered, command: Command, schema: z.ZodType<T>) {
  const stub = environment.BUDGET.get(environment.BUDGET.idFromName("global"));
  const response = await stub.fetch(
    new Request("https://budget/", { method: "POST", body: JSON.stringify(command) }),
  );
  return schema.parse(await response.json());
}

const Admitted = z.object({ admitted: z.boolean() });

/**
 * Asks today's budget to admit one metered call from this request's client, charging it at once
 * for every meter but OpenAI's; answers whether it may go on.
 */
export async function admit(
  environment: Metered,
  request: Request,
  meterName: "openai" | "images" | "jev" | "reactor",
  amount: number,
  lease?: string,
): Promise<boolean> {
  const { admitted } = await meter(
    environment,
    {
      kind: "admit",
      meter: meterName,
      amount,
      block: blockOf(visitorOf(request)),
      ceilings: ceilings(environment),
      ...(lease === undefined ? {} : { lease }),
    },
    Admitted,
  );
  note({ budget: { meter: meterName, amount, admitted } });
  return admitted;
}

/** Gives a Reactor lease's unused seconds back to today's budget once its session has ended. */
export async function refund(environment: Metered, lease: string): Promise<void> {
  await meter(environment, { kind: "refund", lease }, z.unknown());
}

/** The answer a metered route gives once today's budget for it is gone. */
export const busy = () => reply(503, busyCopy, { "Retry-After": "3600" });

const imageTokens = 1_500;

/**
 * A conservative token count for a Responses request whose answer carried no usage: every inline
 * image at a high-detail image's cost, and the rest at one token per three characters, a little
 * above what text holds, which covers the output a cut answer had streamed.
 */
export function estimateTokens(requestText: string): number {
  const images = requestText.match(/data:image\/[^"]*/g) ?? [];
  const textCharacters = images.reduce((left, image) => left - image.length, requestText.length);
  return images.length * imageTokens + Math.ceil(textCharacters / 3);
}

const tailBytes = 8192;
const inputTokensPattern = /"input_tokens":(\d+)/g;
const outputTokensPattern = /"output_tokens":(\d+)/g;

function lastCount(text: string, pattern: RegExp): number | null {
  const found = [...text.matchAll(pattern)].at(-1)?.[1];
  return found === undefined ? null : Number(found);
}

/**
 * The tokens an answer's usage reports, read from the end of its text: a stream's last event and
 * a JSON body both close with the response's usage. Keys inside the answer's own text arrive
 * escaped, so only the real usage keys match.
 */
export function usageOf(tail: string): number | null {
  const input = lastCount(tail, inputTokensPattern);
  const output = lastCount(tail, outputTokensPattern);
  return input === null || output === null ? null : input + output;
}

/**
 * Passes a successful Responses answer through to the page untouched and charges it to today's
 * budget once it ends: the usage its last 8 KiB report, or with none (a cut answer) the
 * conservative estimate. The body is teed and piped natively, and the meter's copy is read whole
 * in the background, so no script runs per chunk: parsing every event, whose opening ones echo
 * the whole instructions, ran the Worker past its CPU limit and cut answers mid-event. When the
 * page stops reading, `abortUpstream` ends the call upstream.
 */
export function meteredAnswer(
  environment: Metered,
  request: Request,
  requestText: string,
  upstream: Response,
  background: Background,
  abortUpstream: () => void,
): Response {
  const block = blockOf(visitorOf(request));
  const [forPage, copy] = upstream.body === null ? [null, null] : upstream.body.tee();
  const piped = forPage === null ? null : new TransformStream<Uint8Array, Uint8Array>();
  if (forPage !== null && piped !== null)
    background.waitUntil(forPage.pipeTo(piped.writable).catch(abortUpstream));
  const read = copy === null ? Promise.resolve(null) : new Response(copy).arrayBuffer();
  const charging = read
    .catch(() => null)
    .then((bytes) => {
      const tail = bytes === null ? "" : new TextDecoder().decode(bytes.slice(-tailBytes));
      const tokens = usageOf(tail) ?? estimateTokens(requestText);
      return meter(environment, { kind: "charge", tokens, block }, z.unknown());
    })
    .then(
      () => undefined,
      () => undefined,
    );
  background.waitUntil(charging);
  return new Response(piped?.readable ?? null, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const Report = z.object({
  day: z.string(),
  openAITokens: z.number(),
  images: z.number(),
  jev: z.number(),
  reactorSeconds: z.number(),
  blocks: z.number(),
  topBlocks: z.array(z.number()),
});

async function sameSecret(given: string, secret: string): Promise<boolean> {
  const digest = async (text: string) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  return a.reduce((difference, byte, i) => difference | (byte ^ (b[i] ?? 0)), 0) === 0;
}

/**
 * `GET /api/budget`: today's hosted spend against every ceiling, for the owner only. The request
 * must carry the `BUDGET_TOKEN` secret in an `X-Budget-Token` header; without the secret set, or
 * with any other header, the route does not exist. Holds no secret and names no client.
 */
export async function budgetRoute(environment: Metered, request: Request): Promise<Response> {
  const secret = environment.BUDGET_TOKEN ?? "";
  const given = request.headers.get("X-Budget-Token") ?? "";
  if (secret.length < 16 || !(await sameSecret(given, secret))) return reply(404, "Not found");
  if (request.method !== "GET") return reply(405, "Method not allowed", { Allow: "GET" });
  const report = await meter(environment, { kind: "report" }, Report);
  return json(200, { ...report, ceilings: ceilings(environment) });
}
