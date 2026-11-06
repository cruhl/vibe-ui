import { budgetRoute } from "./budget.ts";
import { json, reply, sameOrigin, type Background, type Environment } from "./http.ts";
import { logRoute, traced } from "./log.ts";
import { passConfigured, passRoute, requirePass } from "./pass.ts";
import { ownJev, providerRoute } from "./proxies.ts";
import { reactorRoute, sessionLimits } from "./sessions.ts";
import { worldsRoute } from "./worlds.ts";

export { Budget } from "./budget.ts";
export { Passes } from "./pass.ts";
export { Sessions } from "./sessions.ts";

/**
 * Whether hosted play is on: the `HOSTED` var says `on` (the kill switch: anything else turns
 * every hosted route off at once) and the three required keys are set as secrets.
 */
function hostedOn(environment: Environment): boolean {
  return (
    environment.HOSTED === "on" &&
    (environment.REACTOR_API_KEY ?? "") !== "" &&
    (environment.OPENAI_API_KEY ?? "") !== "" &&
    (environment.TYPESAFE_API_KEY ?? "") !== ""
  );
}

/**
 * `/api/config`: what the page needs before it starts. Holds no secret; the Turnstile site key is
 * public by design, and hosted play is on only when passes can be issued.
 */
function config(environment: Environment): Response {
  const hosted = hostedOn(environment) && passConfigured(environment);
  return json(200, {
    hosted,
    turnstile: hosted ? (environment.TURNSTILE_SITE_KEY ?? null) : null,
    sessions: hosted ? sessionLimits(environment).visitor : 0,
    fal: hosted && (environment.FAL_KEY ?? "") !== "",
  });
}

async function api(
  request: Request,
  environment: Environment,
  background: Background,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/api/config") return config(environment);
  if (pathname === "/api/budget") return budgetRoute(environment, request);
  if (!sameOrigin(request)) return reply(403, "Forbidden origin");
  if (pathname === "/api/log") return logRoute(environment, request, background);
  if (pathname === "/api/worlds" || pathname.startsWith("/api/worlds/")) {
    if (request.method === "POST" && environment.HOSTED !== "on")
      return reply(503, "Sharing is off right now");
    return worldsRoute(environment, request);
  }
  if (request.method !== "POST") return reply(405, "Method not allowed", { Allow: "POST" });
  if (!hostedOn(environment)) return reply(503, "The demo is off right now");
  if (pathname === "/api/pass") return passRoute(environment, request);
  const denied = await requirePass(environment, request);
  if (denied !== null) return denied;
  if (pathname.startsWith("/api/reactor/")) return reactorRoute(environment, request);
  return providerRoute(environment, request, background);
}

async function route(
  request: Request,
  environment: Environment,
  background: Background,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/jev" || pathname.startsWith("/jev/")) {
    if (request.method !== "POST") return reply(405, "Method not allowed", { Allow: "POST" });
    return sameOrigin(request) ? ownJev(request) : reply(403, "Forbidden origin");
  }
  if (pathname === "/api" || pathname.startsWith("/api/"))
    return api(request, environment, background);
  return environment.ASSETS.fetch(request);
}

/**
 * The public deployment: the built page as static assets, `/jev` for pages on their visitor's own
 * keys, and `/api/*` for hosted play, where this Worker holds the keys and the browser never sees
 * one. Every hosted route is same-origin only, needs a pass (`/api/pass`, earned with an invisible
 * Turnstile challenge), is rate limited per visitor, size and model capped, metered against daily
 * ceilings, and switched off together by the `HOSTED` var. Every request is logged as one
 * structured line to Workers Logs, and pages post their run logs to `/api/log` (deploy/log.ts).
 */
export default {
  async fetch(
    request: Request,
    environment: Environment,
    background: Background,
  ): Promise<Response> {
    return traced(request, environment, background, () => route(request, environment, background));
  },
};
