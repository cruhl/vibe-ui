import { z } from "zod";

/** A Workers rate limiting binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** The static assets binding. */
export interface Assets {
  fetch(request: Request): Promise<Response>;
}

/** A Durable Object stub's one method this Worker uses. */
export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/** A Durable Object namespace, as far as this Worker uses it. */
export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}

/** A Workers KV namespace, as far as this Worker uses it. */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

/** The part of a request's execution context this Worker uses: work that outlives the answer. */
export interface Background {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Everything the Worker is given: bindings, the vars in `wrangler.jsonc` and the secrets set with
 * `scripts/deploy.ts --secrets`. A secret that was never set is undefined.
 */
export interface Environment {
  ASSETS: Assets;
  SESSIONS: DurableObjectNamespace;
  WORLDS: KVNamespace;
  LIMIT_AGENT: RateLimiter;
  LIMIT_JEV: RateLimiter;
  LIMIT_FAL: RateLimiter;
  LIMIT_SESSIONS: RateLimiter;
  LIMIT_WORLDS: RateLimiter;
  HOSTED?: string;
  VISITOR_SESSIONS?: string;
  GLOBAL_SESSIONS?: string;
  SESSION_SECONDS?: string;
  OPENAI_MODELS?: string;
  REACTOR_API_KEY?: string;
  OPENAI_API_KEY?: string;
  TYPESAFE_API_KEY?: string;
  FAL_KEY?: string;
  BUDGET: DurableObjectNamespace;
  DAILY_OPENAI_TOKENS?: string;
  DAILY_BLOCK_TOKENS?: string;
  DAILY_IMAGES?: string;
  DAILY_JEV?: string;
  DAILY_REACTOR_SECONDS?: string;
  BUDGET_TOKEN?: string;
  LIMIT_PASS: RateLimiter;
  PASSES: DurableObjectNamespace;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  PASS_SECRET?: string;
}

/** A plain-text answer that is never cached or sniffed. */
export function reply(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/** A JSON answer that is never cached. */
export function json(
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}

/** An upstream answer passed through with its status, body stream and content type only. */
export function passThrough(upstream: Response): Response {
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "Content-Type": upstream.headers.get("Content-Type") ?? "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

const failureCharacters = 16 * 1024;

/**
 * An upstream failure passed on with its status and its body when that is at most 16 KiB, every
 * secret given replaced, so no provider error ever echoes a key the Worker sent it.
 */
export async function scrubbedFailure(
  upstream: Response,
  secrets: readonly string[],
): Promise<Response> {
  const body = await upstream.text().catch(() => "");
  const text = body.length > failureCharacters ? "" : body;
  const scrubbed = secrets
    .filter((secret) => secret.length >= 8)
    .reduce((current, secret) => current.replaceAll(secret, "[redacted]"), text);
  return new Response(
    scrubbed === "" ? `Upstream answered HTTP ${String(upstream.status)}` : scrubbed,
    {
      status: upstream.status,
      headers: {
        "Content-Type": upstream.headers.get("Content-Type") ?? "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}

/**
 * Whether a request came from a page on this deployment's own origin: a POST must carry an
 * `Origin` equal to it, and a browser's `Sec-Fetch-Site`, when present, must say same-origin.
 */
export function sameOrigin(request: Request): boolean {
  const url = new URL(request.url);
  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;
  if (request.method === "GET" || request.method === "HEAD") return true;
  return request.headers.get("Origin") === url.origin;
}

/**
 * The /64 network of an IPv6 address, the smallest block one subscriber is handed, or the
 * address itself when it is not IPv6.
 */
export function networkOf(address: string): string {
  if (!address.includes(":") || address.includes(".")) return address;
  const [head = "", tail = ""] = address.toLowerCase().split("::");
  const front = head === "" ? [] : head.split(":");
  const back = address.includes("::") && tail !== "" ? tail.split(":") : [];
  const groups = address.includes("::")
    ? [...front, ...Array<string>(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back]
    : front;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/**
 * Who is asking, for per-visitor limits: the client address Cloudflare saw, an IPv6 one by its
 * /64, since one subscriber holds a whole /64 and could otherwise take a fresh address per request.
 */
export function visitorOf(request: Request): string {
  return networkOf(request.headers.get("CF-Connecting-IP") ?? "local");
}

/**
 * Counts one request against a per-visitor limiter, and answers 429 when the visitor is over it,
 * or null to go on.
 */
export async function overLimit(limiter: RateLimiter, request: Request): Promise<Response | null> {
  const { success } = await limiter.limit({ key: visitorOf(request) });
  return success
    ? null
    : reply(429, "Too many requests. Wait a minute and try again.", { "Retry-After": "60" });
}

/** Reads a request body up to a byte cap, or null when it is empty or larger. */
export async function readBounded(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes || request.body === null) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  if (total === 0) return null;
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

const AnyJSON = z.string().transform((raw, context): unknown => {
  try {
    const value: unknown = JSON.parse(raw);
    return value;
  } catch {
    context.addIssue({ code: "custom", message: "the body is not JSON" });
    return z.NEVER;
  }
});

/**
 * Reads a JSON request body under a byte cap and checks it against a schema; answers with the
 * parsed value and the raw bytes, or with the error response to send.
 */
export async function readJSON<T>(
  request: Request,
  maxBytes: number,
  schema: z.ZodType<T>,
): Promise<{ value: T; bytes: Uint8Array<ArrayBuffer> } | { failed: Response }> {
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json"))
    return { failed: reply(415, "Content-Type must be application/json") };
  const bytes = await readBounded(request, maxBytes);
  if (bytes === null)
    return { failed: reply(413, `The body is empty or larger than ${String(maxBytes)} bytes`) };
  const parsed = AnyJSON.pipe(schema).safeParse(new TextDecoder().decode(bytes));
  if (!parsed.success)
    return {
      failed: reply(
        400,
        `Refused: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
      ),
    };
  return { value: parsed.data, bytes };
}

/** A whole-number var, or the fallback when it is unset or not a positive number. */
export function count(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
