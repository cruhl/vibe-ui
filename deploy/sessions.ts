import { z } from "zod";
import { admit, busyCopy, refund } from "./budget.ts";
import { count, json, overLimit, readJSON, reply, visitorOf, type Environment } from "./http.ts";

const reactorAPI = "https://api.reactor.inc";
const omniModel = "reactor/fast-h3-omni";
const mintWindowMs = 10 * 60_000;
const mintsPerWindow = 24;
const tokenSlackSeconds = 300;

/** The session limits of a deployment, from its vars. */
export interface SessionLimits {
  visitor: number;
  global: number;
  seconds: number;
}

/** The session limits a deployment's vars set, with the defaults for any left unset. */
export function sessionLimits(environment: Environment): SessionLimits {
  return {
    visitor: count(environment.VISITOR_SESSIONS, 2),
    global: count(environment.GLOBAL_SESSIONS, 5),
    seconds: count(environment.SESSION_SECONDS, 600),
  };
}

const Lease = z.object({
  visitor: z.string(),
  jwt: z.string().nullable(),
  sessionID: z.string().nullable(),
  expiresAt: z.number(),
});
type Lease = z.infer<typeof Lease>;

const Command = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("acquire"),
    visitor: z.string(),
    limits: z.object({ visitor: z.number(), global: z.number(), seconds: z.number() }),
  }),
  z.object({ kind: z.literal("attach"), lease: z.string(), jwt: z.string() }),
  z.object({
    kind: z.literal("bind"),
    lease: z.string(),
    visitor: z.string(),
    sessionID: z.string(),
    seconds: z.number(),
  }),
  z.object({ kind: z.literal("lookup"), lease: z.string(), visitor: z.string() }),
  z.object({ kind: z.literal("release"), lease: z.string(), visitor: z.string() }),
]);
type Command = z.infer<typeof Command>;

const Stored = z.object({
  leases: z.array(z.tuple([z.string(), Lease])),
  mints: z.array(z.tuple([z.string(), z.array(z.number())])),
});

interface DurableObjectState {
  storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> };
  blockConcurrencyWhile<T>(run: () => Promise<T>): Promise<T>;
}

/** How long a minted token lives: the session's capped duration and a slack for reading its steps. */
const tokenSeconds = (seconds: number) => seconds + tokenSlackSeconds;

/**
 * How long a lease nobody bound stays counted: while its token can still start a session, plus
 * that session's capped duration, since the token works whether or not the lease is held.
 */
const unboundSeconds = (seconds: number) => tokenSeconds(seconds) + seconds;

/**
 * The one ledger of hosted Reactor sessions, a single Durable Object every request goes through,
 * so counts never race. A lease is taken before a token is minted and held while its session can
 * run: while unbound, for as long as its token could still start a session and that session run;
 * once bound, for the session's whole capped duration; or until the page ends it. Caps: leases
 * per visitor, leases in all, and tokens a visitor may mint per ten minutes.
 */
export class Sessions {
  private leases = new Map<string, Lease>();
  private mints = new Map<string, number[]>();

  constructor(private readonly state: DurableObjectState) {
    void state.blockConcurrencyWhile(async () => {
      const parsed = Stored.safeParse(await state.storage.get("ledger"));
      if (!parsed.success) return;
      this.leases = new Map(parsed.data.leases);
      this.mints = new Map(parsed.data.mints);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const body: unknown = await request.json();
    const parsed = Command.safeParse(body);
    if (!parsed.success) return json(400, { error: "bad command" });
    const answer = this.run(parsed.data, Date.now());
    await this.state.storage.put("ledger", { leases: [...this.leases], mints: [...this.mints] });
    return json(200, answer);
  }

  private prune(now: number): void {
    for (const [id, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(id);
    for (const [visitor, times] of this.mints) {
      const recent = times.filter((time) => time > now - mintWindowMs);
      if (recent.length === 0) this.mints.delete(visitor);
      else this.mints.set(visitor, recent);
    }
  }

  private owned(lease: string, visitor: string): Lease | null {
    const found = this.leases.get(lease);
    return found !== undefined && found.visitor === visitor ? found : null;
  }

  private run(command: Command, now: number): unknown {
    this.prune(now);
    const leases = [...this.leases.values()];
    switch (command.kind) {
      case "acquire": {
        const mine = leases.filter((lease) => lease.visitor === command.visitor).length;
        const minted = this.mints.get(command.visitor) ?? [];
        if (mine >= command.limits.visitor) return { refused: "visitor" };
        if (leases.length >= command.limits.global) return { refused: "global" };
        if (minted.length >= mintsPerWindow) return { refused: "mints" };
        const id = crypto.randomUUID();
        this.leases.set(id, {
          visitor: command.visitor,
          jwt: null,
          sessionID: null,
          expiresAt: now + unboundSeconds(command.limits.seconds) * 1000,
        });
        this.mints.set(command.visitor, [...minted, now]);
        return { lease: id };
      }
      case "attach": {
        const found = this.leases.get(command.lease);
        if (found !== undefined) found.jwt = command.jwt;
        return { attached: found !== undefined };
      }
      case "bind": {
        const found = this.owned(command.lease, command.visitor);
        if (found === null) return { bound: false };
        found.sessionID = command.sessionID;
        found.expiresAt = now + (command.seconds + 30) * 1000;
        return { bound: true };
      }
      case "lookup": {
        const found = this.owned(command.lease, command.visitor);
        return found === null
          ? { found: false }
          : { found: true, jwt: found.jwt, sessionID: found.sessionID };
      }
      case "release": {
        const found = this.owned(command.lease, command.visitor);
        if (found !== null) this.leases.delete(command.lease);
        return { released: found !== null, sessionID: found?.sessionID ?? null };
      }
    }
  }
}

const Acquired = z.union([
  z.object({ lease: z.string() }),
  z.object({ refused: z.enum(["visitor", "global", "mints"]) }),
]);
const LookedUp = z.union([
  z.object({ found: z.literal(false) }),
  z.object({
    found: z.literal(true),
    jwt: z.string().nullable(),
    sessionID: z.string().nullable(),
  }),
]);
const Released = z.object({ released: z.boolean(), sessionID: z.string().nullable() });
const Token = z.object({ jwt: z.string() });

async function ledger<T>(
  environment: Environment,
  command: Command,
  schema: z.ZodType<T>,
): Promise<T> {
  const stub = environment.SESSIONS.get(environment.SESSIONS.idFromName("global"));
  const response = await stub.fetch(
    new Request("https://sessions/", { method: "POST", body: JSON.stringify(command) }),
  );
  return schema.parse(await response.json());
}

const refusals = {
  visitor: "This browser has too many sessions open. Close one, or use your own API keys.",
  global: "The demo is full right now. Try again in a minute, or use your own API keys.",
  mints: "Too many new sessions from here. Wait a few minutes, or use your own API keys.",
} as const;

async function mint(environment: Environment, request: Request): Promise<Response> {
  const key = environment.REACTOR_API_KEY ?? "";
  const limits = sessionLimits(environment);
  const visitor = visitorOf(request);
  const acquired = await ledger(environment, { kind: "acquire", visitor, limits }, Acquired);
  if ("refused" in acquired)
    return json(
      429,
      { error: refusals[acquired.refused], refused: acquired.refused },
      { "Retry-After": "60" },
    );
  if (!(await admit(environment, request, "reactor", limits.seconds, acquired.lease))) {
    await ledger(environment, { kind: "release", lease: acquired.lease, visitor }, Released);
    return json(503, { error: busyCopy, refused: "budget" }, { "Retry-After": "3600" });
  }
  const upstream = await fetch(`${reactorAPI}/tokens`, {
    method: "POST",
    headers: { "Reactor-API-Key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: tokenSeconds(limits.seconds),
      authorization_details: [
        {
          type: "session",
          resources: { models: { match: [omniModel] } },
          constraints: { max_sessions: 1, max_session_duration_seconds: limits.seconds },
        },
      ],
    }),
  }).catch(() => null);
  const token = upstream?.ok === true ? Token.safeParse(await upstream.json()) : null;
  if (token?.success !== true) {
    await ledger(environment, { kind: "release", lease: acquired.lease, visitor }, Released);
    await refund(environment, acquired.lease);
    return json(502, {
      error: `Couldn't start a session (HTTP ${String(upstream?.status ?? "unreachable")})`,
    });
  }
  await ledger(
    environment,
    { kind: "attach", lease: acquired.lease, jwt: token.data.jwt },
    z.unknown(),
  );
  return json(200, { jwt: token.data.jwt, lease: acquired.lease, seconds: limits.seconds });
}

const SessionID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const LeaseBody = z.object({ lease: z.uuid(), sessionID: SessionID.optional() });

async function sessionOfToken(jwt: string, sessionID: string): Promise<boolean> {
  const response = await fetch(`${reactorAPI}/sessions/${sessionID}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  }).catch(() => null);
  await response?.body?.cancel();
  return response?.ok === true;
}

async function register(environment: Environment, request: Request): Promise<Response> {
  const body = await readJSON(request, 4096, LeaseBody);
  if ("failed" in body) return body.failed;
  const { lease, sessionID } = body.value;
  if (sessionID === undefined) return reply(400, "sessionID is required");
  const visitor = visitorOf(request);
  const found = await ledger(environment, { kind: "lookup", lease, visitor }, LookedUp);
  if (!found.found || found.jwt === null) return reply(404, "No such lease");
  if (!(await sessionOfToken(found.jwt, sessionID)))
    return reply(403, "That session does not belong to this lease");
  const { seconds } = sessionLimits(environment);
  await ledger(environment, { kind: "bind", lease, visitor, sessionID, seconds }, z.unknown());
  return json(200, { bound: true });
}

async function terminate(key: string, sessionID: string): Promise<number | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await fetch(`${reactorAPI}/sessions/${sessionID}`, {
      method: "DELETE",
      headers: { "Reactor-API-Key": key },
    }).catch(() => null);
    await response?.body?.cancel();
    if (response !== null && (response.ok || response.status === 404)) return response.status;
    if (response !== null && response.status !== 409 && response.status < 500)
      return response.status;
    await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
  }
  return null;
}

async function end(environment: Environment, request: Request): Promise<Response> {
  const body = await readJSON(request, 4096, LeaseBody);
  if ("failed" in body) return body.failed;
  const { lease } = body.value;
  const visitor = visitorOf(request);
  const found = await ledger(environment, { kind: "lookup", lease, visitor }, LookedUp);
  if (!found.found) return json(200, { ended: false, reason: "no such lease" });
  const claimed = body.value.sessionID;
  const sessionID =
    found.sessionID ??
    (claimed !== undefined && found.jwt !== null && (await sessionOfToken(found.jwt, claimed))
      ? claimed
      : null);
  const status =
    sessionID === null ? null : await terminate(environment.REACTOR_API_KEY ?? "", sessionID);
  await ledger(environment, { kind: "release", lease, visitor }, Released);
  await refund(environment, lease);
  return json(200, { ended: true, sessionID, status });
}

/**
 * The hosted Reactor routes, all POST from this origin under the session limiter:
 * `/api/reactor/token` takes a lease and mints a token for one FastH3-Omni session of capped
 * duration, charged at that length to today's session-seconds budget; `/api/reactor/register` binds the session the token created to the lease, checked
 * against Reactor with that token; `/api/reactor/end` terminates the lease's session with the
 * deployment's key, frees the lease and refunds the budget what the session did not use.
 */
export async function reactorRoute(environment: Environment, request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/reactor/token") {
    const limited = await overLimit(environment.LIMIT_SESSIONS, request);
    return limited ?? mint(environment, request);
  }
  if (pathname === "/api/reactor/register") return register(environment, request);
  if (pathname === "/api/reactor/end") return end(environment, request);
  return reply(404, "Not found");
}
