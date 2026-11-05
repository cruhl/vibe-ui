import { z } from "zod";
import { json, overLimit, readJSON, reply, visitorOf, type Environment } from "./http.ts";

const siteverifyURL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const cookieName = "__Host-vibe-pass";
const passSeconds = 15 * 60;
const minimumSecretLength = 32;
const maxTokenLength = 2048;
const spentSeconds = 360;

/** The Turnstile action the page's widget names, checked on every token. */
export const passAction = "hosted";

const PassBody = z.strictObject({ token: z.string().min(1).max(maxTokenLength) });

const Verdict = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  "error-codes": z.array(z.string()).default([]),
});

const CookieValue = z.string().regex(/^\d{1,15}\.[A-Za-z0-9_-]{43}$/);

const Spend = z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) });
const Spent = z.array(z.tuple([z.string(), z.number()]));
const Fresh = z.object({ fresh: z.boolean() });

interface DurableObjectState {
  storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
}

/**
 * The one record of Turnstile tokens already traded for a pass, a single Durable Object, so a
 * token is spent once across every location. siteverify alone does not hold that from a Worker:
 * a token it refused as a duplicate within one request passed again in the next. Each digest is
 * kept six minutes, past the token's own 300-second life.
 */
export class Passes {
  private spent = new Map<string, number>();

  constructor(private readonly state: DurableObjectState) {
    void state.blockConcurrencyWhile(async () => {
      const parsed = Spent.safeParse(await state.storage.get("spent"));
      if (parsed.success) this.spent = new Map(parsed.data);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const parsed = Spend.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return json(400, { error: "bad command" });
    const now = Date.now();
    for (const [digest, until] of this.spent) if (until <= now) this.spent.delete(digest);
    const fresh = !this.spent.has(parsed.data.digest);
    if (fresh) this.spent.set(parsed.data.digest, now + spentSeconds * 1000);
    await this.state.storage.put("spent", [...this.spent]);
    return json(200, { fresh });
  }
}

/** Whether a token was never traded before, marking it spent either way. */
async function spendToken(environment: Environment, token: string): Promise<boolean> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const digest = [...new Uint8Array(hash)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const ledger = environment.PASSES.get(environment.PASSES.idFromName("spent"));
  const answer = await ledger
    .fetch(new Request("https://passes/", { method: "POST", body: JSON.stringify({ digest }) }))
    .catch(() => null);
  const parsed = Fresh.safeParse(await answer?.json().catch(() => null));
  return parsed.success && parsed.data.fresh;
}

/** Whether this deployment can issue passes: the site key, Turnstile secret and signing secret are set. */
export function passConfigured(environment: Environment): boolean {
  return (
    (environment.TURNSTILE_SITE_KEY ?? "") !== "" &&
    (environment.TURNSTILE_SECRET_KEY ?? "") !== "" &&
    (environment.PASS_SECRET ?? "").length >= minimumSecretLength
  );
}

function signingKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

const signedText = (expiresAt: number, visitor: string) =>
  new TextEncoder().encode(`vibe-pass.v1|${String(expiresAt)}|${visitor}`);

function toBase64URL(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64URL(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * A signed pass for one visitor's network: `<expiresAt ms>.<HMAC-SHA256 of it and the network>`,
 * signed with the `PASS_SECRET` the Worker alone holds.
 */
export async function signPass(
  secret: string,
  visitor: string,
  expiresAt: number,
): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    signedText(expiresAt, visitor),
  );
  return `${String(expiresAt)}.${toBase64URL(signature)}`;
}

/**
 * Whether a pass is genuine, unexpired, no longer-lived than one pass, and signed for this
 * visitor's network. The signature check is the platform's constant-time HMAC verify.
 */
export async function passValid(
  secret: string,
  visitor: string,
  value: string,
  now: number,
): Promise<boolean> {
  if (secret.length < minimumSecretLength || !CookieValue.safeParse(value).success) return false;
  const [stamp = "", signature = ""] = value.split(".");
  const expiresAt = Number(stamp);
  if (!(expiresAt > now) || expiresAt > now + passSeconds * 1000) return false;
  return crypto.subtle.verify(
    "HMAC",
    await signingKey(secret),
    fromBase64URL(signature),
    signedText(expiresAt, visitor),
  );
}

function cookieOf(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  const found = header
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName}=`));
  return found === undefined ? null : found.slice(cookieName.length + 1);
}

/**
 * `/api/pass`: trades one Turnstile token for a pass. The token is spent in the `Passes` ledger,
 * then checked with siteverify (with the client address, and for this hostname and the page's
 * action); tokens are single use and live 300 seconds, so a replayed or stale one is refused. The pass is a
 * 15-minute `__Host-` cookie, HttpOnly, Secure and SameSite=Strict, signed for the visitor's
 * network (an IPv4 address, or an IPv6 /64); the answer says when it expires so the page can
 * renew it first.
 */
export async function passRoute(environment: Environment, request: Request): Promise<Response> {
  if (!passConfigured(environment)) return reply(503, "Hosted play is not set up");
  const limited = await overLimit(environment.LIMIT_PASS, request);
  if (limited !== null) return limited;
  const body = await readJSON(request, 4096, PassBody);
  if ("failed" in body) return body.failed;
  if (!(await spendToken(environment, body.value.token)))
    return reply(403, "The challenge did not pass");
  const address = request.headers.get("CF-Connecting-IP");
  const answer = await fetch(siteverifyURL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      secret: environment.TURNSTILE_SECRET_KEY ?? "",
      response: body.value.token,
      ...(address === null ? {} : { remoteip: address }),
    }),
  }).catch(() => null);
  if (answer === null || !answer.ok)
    return reply(502, "The challenge service could not be reached");
  const verdict = Verdict.safeParse(await answer.json().catch(() => null));
  if (!verdict.success) return reply(502, "The challenge service answered nonsense");
  const { success, hostname, action } = verdict.data;
  if (!success || hostname !== new URL(request.url).hostname || action !== passAction)
    return reply(403, "The challenge did not pass");
  const expiresAt = Date.now() + passSeconds * 1000;
  const value = await signPass(environment.PASS_SECRET ?? "", visitorOf(request), expiresAt);
  return json(
    200,
    { expiresAt },
    {
      "Set-Cookie": `${cookieName}=${value}; Max-Age=${String(passSeconds)}; Path=/; HttpOnly; Secure; SameSite=Strict`,
    },
  );
}

/**
 * Answers 403 with `X-Pass: required` unless the request carries a valid pass for its own
 * network, or null to go on. With the pass secrets unset, nothing passes.
 */
export async function requirePass(
  environment: Environment,
  request: Request,
): Promise<Response | null> {
  const value = cookieOf(request);
  const valid =
    value !== null &&
    passConfigured(environment) &&
    (await passValid(environment.PASS_SECRET ?? "", visitorOf(request), value, Date.now()));
  return valid ? null : reply(403, "A fresh pass is required", { "X-Pass": "required" });
}
