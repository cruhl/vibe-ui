import { z } from "zod";
import { record } from "../run-log/index.ts";
import { captureStream, readAgentRequest, type AgentReplay } from "./agent-replay.ts";
import { beginRealCall } from "./clock.ts";
import { answerJev, jevLatencyMs } from "./jev-mock.ts";

export interface ShimOptions {
  jevMock: boolean;
  /** Answers fal image calls with the picture they were given, after a measured delay. */
  falMock: boolean;
  replay: AgentReplay | null;
  /** Recorded Jev answers by question type and text, from a replay kit. */
  jevAnswers?: ReadonlyMap<string, readonly unknown[]>;
  /** Stretches the mocked Jev and fal delays; see `mockDelayScale`. */
  delayScale?: number;
}

const falLatencyMs = 1500;
const blankImage =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function requestURL(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

function parseBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return null;
  }
}

/**
 * Wraps the page's fetch for an eval run: answers Jev with canned boxes and fal with its own picture when mocked, replays or
 * captures agent replies, and holds the content clock at wall time while a real call is in flight.
 * The simulated user's own model calls never hold the clock; its think time is modeled instead.
 */
export function installFetchShim(options: ShimOptions): void {
  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = requestURL(input);
    const sameOrigin = url.startsWith("/") && !url.startsWith("/jev");
    if (sameOrigin) return realFetch(input, init);
    if (options.jevMock && url.endsWith("/v1/systemone")) {
      const body = answerJev(parseBody(init), options.jevAnswers);
      await new Promise((resolve) => setTimeout(resolve, jevLatencyMs * (options.delayScale ?? 1)));
      if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (options.falMock && url.startsWith("https://fal.run/")) {
      const body = z.looseObject({ image_url: z.string().optional() }).safeParse(parseBody(init));
      const image = (body.success ? body.data.image_url : undefined) ?? blankImage;
      await new Promise((resolve) => setTimeout(resolve, falLatencyMs * (options.delayScale ?? 1)));
      if (init?.signal?.aborted === true) throw new DOMException("aborted", "AbortError");
      record("fal_mocked", { model: url.slice("https://fal.run/".length) });
      return new Response(JSON.stringify({ images: [{ url: image }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const agent = url.endsWith("/responses") ? readAgentRequest(parseBody(init)) : null;
    if (agent?.format === "user_decision") return realFetch(input, init);
    if (agent !== null && options.replay !== null)
      return options.replay.serve(agent, init?.signal ?? null);
    const startedAt = performance.now();
    const end = beginRealCall();
    try {
      const response = await realFetch(input, init);
      if (agent === null || !response.ok) {
        void response
          .clone()
          .arrayBuffer()
          .catch(() => undefined)
          .finally(end);
        return response;
      }
      return captureStream(response, agent, end, startedAt);
    } catch (error: unknown) {
      end();
      record("eval_fetch_failed", { url: url.slice(0, 80), message: String(error) });
      throw error;
    }
  };
}
