import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { redact } from "../src/run-log/redact.ts";
import {
  overLimit,
  readBounded,
  reply,
  visitorOf,
  type Background,
  type Environment,
} from "./http.ts";

/** One upstream call a request made: where, how it answered, and how long the answer took. */
interface UpstreamCall {
  host: string;
  path: string;
  method: string;
  status: number | null;
  milliseconds: number;
  error?: string;
}

interface Trace {
  fields: Record<string, unknown>;
  upstream: UpstreamCall[];
  waits: Promise<unknown>[];
  secrets: string[];
}

const traces = new AsyncLocalStorage<Trace>();
const bodyCharacters = 4096;
const sessionPattern = /^[A-Za-z0-9_-]{1,96}$/;
const secretHeaders = ["authorization", "reactor-api-key", "x-api-key", "cookie"];
let installed = false;

/** The session id a request names in `X-Vibe-Session`, or null when absent or malformed. */
export function sessionOf(request: Request): string | null {
  const value = request.headers.get("X-Vibe-Session") ?? "";
  return sessionPattern.test(value) ? value : null;
}

/** Adds fields, such as the pass status or a budget decision, to this request's log line. */
export function note(fields: Record<string, unknown>): void {
  const trace = traces.getStore();
  if (trace !== undefined) Object.assign(trace.fields, fields);
}

function deploymentSecrets(environment: Environment): string[] {
  return [
    environment.REACTOR_API_KEY,
    environment.OPENAI_API_KEY,
    environment.TYPESAFE_API_KEY,
    environment.FAL_KEY,
    environment.TURNSTILE_SECRET_KEY,
    environment.PASS_SECRET,
    environment.BUDGET_TOKEN,
  ].flatMap((value) => (value === undefined || value === "" ? [] : [value]));
}

async function boundedText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.slice(0, bodyCharacters);
}

function headerSecrets(init: RequestInit | undefined, input: RequestInfo | URL): string[] {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : {}));
  return secretHeaders.flatMap((name) => {
    const value = headers.get(name);
    if (value === null) return [];
    const bare = value.replace(/^(?:Bearer|Key)\s+/i, "");
    return [value, bare];
  });
}

function urlOf(input: RequestInfo | URL): URL | null {
  try {
    return new URL(input instanceof Request ? input.url : input.toString());
  } catch {
    return null;
  }
}

/**
 * Wraps the global `fetch` once so every upstream call made while a request is traced is timed
 * and noted on its log line (host, path, status, milliseconds), and a failure's body is kept with
 * every key the call sent, and every deployment secret, scrubbed out.
 */
function installFetchTrace(): void {
  if (installed) return;
  installed = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const trace = traces.getStore();
    if (trace === undefined) return original(input, init);
    const url = urlOf(input);
    const call: UpstreamCall = {
      host: url?.host ?? "",
      path: url?.pathname ?? "",
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      status: null,
      milliseconds: 0,
    };
    trace.upstream.push(call);
    trace.secrets.push(...headerSecrets(init, input));
    const started = Date.now();
    try {
      const response = await original(input, init);
      call.status = response.status;
      call.milliseconds = Date.now() - started;
      if (!response.ok)
        trace.waits.push(
          boundedText(response.clone()).then((body) => {
            call.error = body;
          }),
        );
      return response;
    } catch (error: unknown) {
      call.milliseconds = Date.now() - started;
      call.error = String(error);
      throw error;
    }
  };
}

function scrubAll(value: unknown, secrets: readonly string[]): unknown {
  return JSON.parse(redact(JSON.stringify(value), secrets));
}

/**
 * Runs one request with a trace and writes its one structured log line to Workers Logs once the
 * answer is out: route, method, status, latency, the visitor's network hashed, the session id,
 * whatever the routes noted (pass status, budget decisions) and every upstream call with its
 * status and timing. A non-2xx answer carries its body, and an upstream failure the upstream's
 * body, each scrubbed of every key, secret, token and Authorization value. An exception is logged
 * with its stack and answered 500. No header, cookie or key is ever logged.
 */
export async function traced(
  request: Request,
  environment: Environment,
  background: Background,
  handle: () => Promise<Response>,
): Promise<Response> {
  installFetchTrace();
  const trace: Trace = { fields: {}, upstream: [], waits: [], secrets: [] };
  const started = Date.now();
  const response = await traces.run(trace, async () => {
    try {
      return await handle();
    } catch (error: unknown) {
      trace.fields.exception =
        error instanceof Error
          ? { message: error.message, stack: error.stack ?? "" }
          : String(error);
      return reply(500, "Something went wrong on our side");
    }
  });
  const latency = Date.now() - started;
  const failed = response.status < 200 || response.status > 299;
  const body = failed ? boundedText(response.clone()) : Promise.resolve(null);
  background.waitUntil(
    (async () => {
      await Promise.allSettled(trace.waits);
      const url = new URL(request.url);
      const line = {
        log: "worker",
        route: url.pathname,
        method: request.method,
        status: response.status,
        milliseconds: latency,
        visitor: await visitorHash(environment, request),
        session: sessionOf(request),
        ...trace.fields,
        upstream: trace.upstream,
        ...(failed ? { body: await body } : {}),
      };
      const scrubbed = scrubAll(line, [...deploymentSecrets(environment), ...trace.secrets]);
      if (failed || trace.fields.exception !== undefined) console.error(scrubbed);
      else console.log(scrubbed);
      const session = sessionOf(request);
      if (session !== null && failureWorthy(response, url.pathname))
        await markFailing(
          environment,
          session,
          `${url.pathname} answered ${String(response.status)}`,
        );
    })().catch((error: unknown) => {
      console.error({ log: "worker", route: "log", exception: String(error) });
    }),
  );
  return response;
}

function failureWorthy(response: Response, pathname: string): boolean {
  if (pathname === "/api/log") return false;
  if (response.status === 403 && response.headers.get("X-Pass") === "required") return false;
  return response.status >= 400;
}

/**
 * A short, salted hash of the visitor's network, stable for one deployment's pass secret, so
 * lines from one visitor group together without the address itself ever being logged.
 */
async function visitorHash(environment: Environment, request: Request): Promise<string> {
  const salt = environment.PASS_SECRET ?? "vibe-ui";
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${salt}:${visitorOf(request)}`),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function markFailing(environment: Environment, session: string, reason: string) {
  await environment.LOGS.put(
    `failing/${session}`,
    JSON.stringify({ session, reason, at: new Date().toISOString() }),
    { httpMetadata: { contentType: "application/json" } },
  );
}

const maxCompressedBytes = 512 * 1024;
const maxBatchBytes = 2 * 1024 * 1024;
const maxLineCharacters = 2048;
const maxLines = 250;

const Batch = z.object({
  session: z.string().regex(sessionPattern),
  sequence: z.number().int().nonnegative().max(1_000_000),
  failed: z.array(z.string().max(64)).max(64),
  events: z.array(z.looseObject({ kind: z.string().max(80), t: z.number() })).max(1000),
});

async function decompressed(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return readBounded(new Response(stream), maxBatchBytes);
}

/**
 * `/api/log`: one batch of a page's run log, for hosted play and play on a visitor's own keys
 * alike. Same origin only, rate limited per visitor, at most 512 KiB as sent (gzip, as
 * `application/gzip`, or plain JSON) and 2 MiB unpacked. Every event is scrubbed again, written
 * to Workers Logs as one structured line (long lines cut to 2 KiB), and the whole batch is kept
 * in R2 as `sessions/<session>/<sequence>.jsonl`; a batch naming failures also marks the session
 * at `failing/<session>`. The bucket's lifecycle rule deletes everything after 30 days.
 */
export async function logRoute(
  environment: Environment,
  request: Request,
  background: Background,
): Promise<Response> {
  if (request.method !== "POST") return reply(405, "Method not allowed", { Allow: "POST" });
  const limited = await overLimit(environment.LIMIT_LOG, request);
  if (limited !== null) return limited;
  const type = request.headers.get("Content-Type") ?? "";
  if (!type.startsWith("application/gzip") && !type.startsWith("application/json"))
    return reply(415, "Content-Type must be application/gzip or application/json");
  const sent = await readBounded(request, maxCompressedBytes);
  if (sent === null) return reply(413, "The batch is empty or too large");
  const bytes = type.startsWith("application/gzip")
    ? await decompressed(sent).catch(() => null)
    : sent;
  if (bytes === null) return reply(413, "The batch does not unpack, or unpacks too large");
  const text = redact(new TextDecoder().decode(bytes), deploymentSecrets(environment));
  const parsed = z
    .string()
    .transform((raw, context): unknown => {
      try {
        const value: unknown = JSON.parse(raw);
        return value;
      } catch {
        context.addIssue({ code: "custom", message: "the batch is not JSON" });
        return z.NEVER;
      }
    })
    .pipe(Batch)
    .safeParse(text);
  if (!parsed.success) return reply(400, "Refused: not a run-log batch");
  const { session, sequence, failed, events } = parsed.data;
  note({ batch: { sequence, events: events.length, failed } });
  for (const event of events.slice(0, maxLines)) {
    const serialized = JSON.stringify(event);
    console.log(
      serialized.length <= maxLineCharacters
        ? { ...event, log: "client", session }
        : {
            log: "client",
            session,
            kind: event.kind,
            t: event.t,
            cut: serialized.slice(0, maxLineCharacters),
          },
    );
  }
  const lines = events.map((event) => JSON.stringify(event)).join("\n");
  background.waitUntil(
    (async () => {
      await environment.LOGS.put(
        `sessions/${session}/${String(sequence).padStart(6, "0")}.jsonl`,
        `${lines}\n`,
        { httpMetadata: { contentType: "application/x-ndjson" } },
      );
      if (failed.length > 0) await markFailing(environment, session, failed.join(", "));
    })(),
  );
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
