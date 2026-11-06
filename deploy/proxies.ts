import { z } from "zod";
import { admit, busy, meteredAnswer } from "./budget.ts";
import {
  overLimit,
  passThrough,
  readBounded,
  readJSON,
  reply,
  scrubbedFailure,
  type Background,
  type Environment,
} from "./http.ts";

const jevUpstream = "https://api.typesafe.ai/v1/systemone";
const jevModels = ["jev-1.14.0"];
const jevMaxBytes = 8 * 1024 * 1024;
const maxAuthorizationLength = 1024;
const agentMaxBytes = 1024 * 1024;
const maxOutputTokens = 32_000;
const falMaxBytes = 8 * 1024 * 1024;

/** The fal models the app calls, each only at this path. */
export const falModels = [
  "fal-ai/flux-kontext/dev",
  "fal-ai/z-image/turbo",
  "fal-ai/birefnet",
  "fal-ai/elevenlabs/sound-effects/v2",
];

/**
 * Forwards one Jev request to TypeSafe with the caller's own key (`/jev/v1/systemone`), for pages
 * running on their visitor's keys: TypeSafe answers no browser origin, so the page posts here on
 * its own origin instead. A Bearer Authorization and a JSON body of at most 8 MiB are required;
 * the upstream status and body come back unchanged.
 */
export async function ownJev(request: Request): Promise<Response> {
  if (new URL(request.url).pathname !== "/jev/v1/systemone") return reply(404, "Not found");
  const authorization = request.headers.get("Authorization") ?? "";
  if (!/^Bearer \S+$/.test(authorization) || authorization.length > maxAuthorizationLength)
    return reply(401, "A Bearer Authorization header with your own key is required");
  if (!(request.headers.get("Content-Type") ?? "").startsWith("application/json"))
    return reply(415, "Content-Type must be application/json");
  const body = await readBounded(request, jevMaxBytes);
  if (body === null) return reply(413, "Request body is empty or larger than 8 MiB");
  return forwardJev(request, authorization, body);
}

async function forwardJev(
  request: Request,
  authorization: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<Response> {
  const headers = new Headers({ Authorization: authorization, "Content-Type": "application/json" });
  const dangerZone = request.headers.get("TypeSafe-Danger-Zone-Images");
  if (dangerZone !== null) headers.set("TypeSafe-Danger-Zone-Images", dangerZone);
  const upstream = await fetch(jevUpstream, { method: "POST", headers, body }).catch(() => null);
  if (upstream === null) return reply(502, "The element service could not be reached");
  return upstream.ok
    ? passThrough(upstream)
    : scrubbedFailure(upstream, [authorization.slice("Bearer ".length)]);
}

const JevBody = z.looseObject({ model: z.enum(jevModels) });

/** `/api/jev/v1/systemone`: one Jev request with the deployment's key, for the app's Jev model only. */
async function hostedJev(environment: Environment, request: Request): Promise<Response> {
  if (new URL(request.url).pathname !== "/api/jev/v1/systemone") return reply(404, "Not found");
  const body = await readJSON(request, jevMaxBytes, JevBody);
  if ("failed" in body) return body.failed;
  if (!(await admit(environment, request, "jev", 1))) return busy();
  return forwardJev(request, `Bearer ${environment.TYPESAFE_API_KEY ?? ""}`, body.bytes);
}

const AgentContent = z.union([
  z.strictObject({ type: z.literal("input_text"), text: z.string() }),
  z.strictObject({
    type: z.literal("input_image"),
    image_url: z.string().startsWith("data:image/"),
    detail: z.enum(["low", "high", "auto"]).optional(),
  }),
]);

const AgentMessage = z.strictObject({
  role: z.enum(["user", "assistant", "system", "developer"]),
  content: z.union([z.string(), z.array(AgentContent)]),
});

function agentBody(models: readonly string[]) {
  return z.strictObject({
    model: z.string().refine((model) => models.includes(model), "is not a hosted model"),
    instructions: z.string().optional(),
    input: z.union([z.string(), z.array(AgentMessage)]),
    reasoning: z.strictObject({ effort: z.enum(["none", "minimal", "low"]) }).optional(),
    max_output_tokens: z.number().int().positive().max(maxOutputTokens).optional(),
    prompt_cache_key: z.string().max(128).optional(),
    stream: z.boolean().optional(),
    text: z.strictObject({ format: z.looseObject({ type: z.literal("json_schema") }) }).optional(),
  });
}

/**
 * `/api/openai/v1/responses`: one Responses call with the deployment's key, streamed straight
 * back. Only the fields the app sends pass (no tools, no stored conversations, input only as text
 * or messages of text and inline images), only the hosted models, at most 1 MiB in and 32,000
 * output tokens out; an omitted output cap gets the ceiling. A failure's body comes back with the
 * key scrubbed from it. A call is admitted only while today's token budget and the client's block
 * budget hold, and its answer's tokens are charged to both.
 */
async function hostedAgent(
  environment: Environment,
  request: Request,
  background: Background,
): Promise<Response> {
  if (new URL(request.url).pathname !== "/api/openai/v1/responses") return reply(404, "Not found");
  const models = (environment.OPENAI_MODELS ?? "gpt-6-luna")
    .split(",")
    .map((model) => model.trim());
  const body = await readJSON(request, agentMaxBytes, agentBody(models));
  if ("failed" in body) return body.failed;
  if (!(await admit(environment, request, "openai", 0))) return busy();
  const abort = new AbortController();
  const upstream = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${environment.OPENAI_API_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ max_output_tokens: maxOutputTokens, ...body.value, store: false }),
    signal: abort.signal,
  }).catch(() => null);
  if (upstream === null) return reply(502, "The agent service could not be reached");
  if (!upstream.ok) return scrubbedFailure(upstream, [environment.OPENAI_API_KEY ?? ""]);
  const requestText = new TextDecoder().decode(body.bytes);
  return meteredAnswer(environment, request, requestText, upstream, background, () => {
    abort.abort();
  });
}

const FalBody = z.looseObject({
  num_images: z.literal(1).optional(),
  num_inference_steps: z.number().int().positive().max(12).optional(),
  image_size: z
    .union([
      z.string().max(40),
      z.strictObject({
        width: z.number().int().positive().max(1024),
        height: z.number().int().positive().max(1024),
      }),
    ])
    .optional(),
  duration_seconds: z.number().positive().max(22).optional(),
});

/**
 * `/api/fal/<model>`: one synchronous fal call with the deployment's key, for the app's models
 * only, one image of at most 1024 by 1024 and 12 steps, or a sound of at most 22 seconds.
 */
async function hostedFal(environment: Environment, request: Request): Promise<Response> {
  const model = new URL(request.url).pathname.slice("/api/fal/".length);
  if (!falModels.includes(model)) return reply(404, "Not a hosted image model");
  if ((environment.FAL_KEY ?? "") === "") return reply(503, "Hosted images are not set up");
  const body = await readJSON(request, falMaxBytes, FalBody);
  if ("failed" in body) return body.failed;
  if (!(await admit(environment, request, "images", 1))) return busy();
  const upstream = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: {
      Authorization: `Key ${environment.FAL_KEY ?? ""}`,
      "Content-Type": "application/json",
    },
    body: body.bytes,
  }).catch(() => null);
  if (upstream === null) return reply(502, "The image service could not be reached");
  return upstream.ok
    ? passThrough(upstream)
    : scrubbedFailure(upstream, [environment.FAL_KEY ?? ""]);
}

/** The hosted provider routes, each POST from this origin under its own per-visitor limiter. */
export async function providerRoute(
  environment: Environment,
  request: Request,
  background: Background,
): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname.startsWith("/api/openai/"))
    return (
      (await overLimit(environment.LIMIT_AGENT, request)) ??
      hostedAgent(environment, request, background)
    );
  if (pathname.startsWith("/api/jev/"))
    return (await overLimit(environment.LIMIT_JEV, request)) ?? hostedJev(environment, request);
  if (pathname.startsWith("/api/fal/"))
    return (await overLimit(environment.LIMIT_FAL, request)) ?? hostedFal(environment, request);
  return reply(404, "Not found");
}
