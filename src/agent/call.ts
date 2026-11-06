import OpenAI from "openai";
import { captureFile } from "../capture/index.ts";
import { hashText } from "../text/index.ts";
import { DeadlineError, record } from "../run-log/index.ts";

/** The fastest GPT-6 model measured for streamed structured output, with reasoning off. */
export const agentModel = "gpt-6-luna";

/**
 * What the person did: the session opened, a click, a click on no box (a point in frame fractions,
 * on the thing Jev saw there or on open background when `thingID` is null), text typed into an
 * input, text typed into a field Jev saw at a point that has no input of its own, or a direct
 * instruction.
 */
export type AgentInput =
  | { kind: "start" }
  | { kind: "click"; elementID: string; label: string }
  | { kind: "point"; x: number; y: number; thingID: string | null; label: string }
  | { kind: "type"; elementID: string; label: string; text: string }
  | { kind: "field"; x: number; y: number; thingID: string | null; label: string; text: string }
  | { kind: "instruct"; text: string };

/**
 * Deadlines in milliseconds. `stall` is the longest gap allowed between two streamed chunks once
 * the first has arrived; `lines` bounds a whole line-format turn.
 */
export const agentDeadlines = {
  firstToken: 5000,
  stall: 4000,
  lines: 15000,
} as const;

/**
 * Where the agent's calls go: OpenAI itself with the visitor's own key (`baseURL` null), or this
 * site's hosted route, which adds its own key (`apiKey` is then a placeholder). `fetch` sends
 * every request, and for the hosted route carries its pass.
 */
export interface OpenAIAccess {
  apiKey: string;
  baseURL: string | null;
  fetch: typeof fetch;
}

const clients = new Map<string, OpenAI>();

/** One OpenAI client per access, shared by every call; its access's `fetch` looks up `window.fetch` per request, so the eval shim sees every call. */
export function getClient(access: OpenAIAccess): OpenAI {
  const id = `${access.baseURL ?? ""} ${access.apiKey}`;
  const existing = clients.get(id);
  if (existing !== undefined) return existing;
  const client = new OpenAI({
    apiKey: access.apiKey,
    ...(access.baseURL === null ? {} : { baseURL: access.baseURL }),
    dangerouslyAllowBrowser: true,
    maxRetries: 0,
    fetch: access.fetch,
  });
  clients.set(id, client);
  return client;
}

const savedInstructions = new Set<string>();

/** Saves an instructions text into the session bundle once, under its hash. */
export function saveInstructions(instructions: string): string {
  const instructionsHash = hashText(instructions);
  if (!savedInstructions.has(instructionsHash)) {
    savedInstructions.add(instructionsHash);
    captureFile(`prompts/${instructionsHash}.md`, instructions);
  }
  return instructionsHash;
}

/** The deadlines of one streamed call, in milliseconds, logged under `name`. */
export interface StreamDeadlines {
  name: string;
  firstToken: number;
  /** The longest gap allowed between two chunks once the first has arrived. */
  stall: number;
  completion: number;
}

/**
 * Runs one streamed call under its deadlines: first token, stall between chunks, and a completion
 * limit, each logged as `<name>_first_token`, `<name>_stall` or `<name>_completion` when missed.
 * Aborts the call on a miss and throws the DeadlineError in its place; an abort from `outer` is
 * logged as `<name>_aborted`.
 */
export async function guarded<T>(
  callID: string | null,
  outer: AbortSignal | undefined,
  deadlines: StreamDeadlines,
  body: (signal: AbortSignal, onChunk: () => void) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  const deadline: { missed: DeadlineError | null } = { missed: null };
  const miss = (name: string, milliseconds: number) => {
    if (deadline.missed !== null) return;
    deadline.missed = new DeadlineError(name, milliseconds);
    record("deadline_missed", { call: name, milliseconds, callID });
    abort.abort();
  };
  const onOuterAbort = () => {
    abort.abort();
  };
  outer?.addEventListener("abort", onOuterAbort);
  const { name } = deadlines;
  let gapTimer = setTimeout(() => {
    miss(`${name}_first_token`, deadlines.firstToken);
  }, deadlines.firstToken);
  const completionTimer = setTimeout(() => {
    miss(`${name}_completion`, deadlines.completion);
  }, deadlines.completion);
  const onChunk = () => {
    clearTimeout(gapTimer);
    gapTimer = setTimeout(() => {
      miss(`${name}_stall`, deadlines.stall);
    }, deadlines.stall);
  };
  try {
    return await body(abort.signal, onChunk);
  } catch (error: unknown) {
    if (outer?.aborted === true) record(`${name}_aborted`, { callID });
    throw deadline.missed ?? error;
  } finally {
    clearTimeout(gapTimer);
    clearTimeout(completionTimer);
    outer?.removeEventListener("abort", onOuterAbort);
  }
}
