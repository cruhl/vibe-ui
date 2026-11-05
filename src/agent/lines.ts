import { forbiddenWords } from "../projector/index.ts";
import { filmLimits, formatEntity, lineLimits, walk, type World } from "../state/index.ts";
import { fill } from "../text/index.ts";
import { record } from "../run-log/index.ts";
import type { MemoryContext } from "../memory/index.ts";
import {
  agentDeadlines,
  agentModel,
  getClient,
  guarded,
  saveInstructions,
  type AgentInput,
  type OpenAIAccess,
} from "./call.ts";
import worldPrompt from "./lines-world.md?raw";
import { splitGlued } from "./split.ts";
import linesPrompt from "./lines.md?raw";

/**
 * A line-format turn: answer an input (with the problems of a rejected try), or only guess, at
 * `count` of the things named in `picks` (all of them when `count` is their number).
 */
export type LinesTurn =
  | { kind: "respond"; input: AgentInput; problems: readonly string[] }
  | { kind: "speculate"; input: AgentInput; picks: readonly string[]; count: number };

export interface LinesRequest {
  openAI: OpenAIAccess;
  premise: string;
  world: World;
  memory: MemoryContext;
  turn: LinesTurn;
  /** How many guesses at the next input each turn writes. */
  guesses: number;
  cacheKey: string;
  signal?: AbortSignal;
  /** The model and reasoning effort; `omit` sends no reasoning setting, for models without one. */
  model?: { name: string; effort: "none" | "minimal" | "low" | "omit" };
}

/** What one line-format call produced, with its timings on the call's own clock. */
export interface LinesResult {
  callID: string;
  text: string;
  lines: string[];
  outputTokens: number | null;
  inputTokens: number | null;
  cachedTokens: number | null;
  firstTokenMs: number | null;
  doneMs: number;
}

/**
 * Output token ceilings: a cascade of changes and beats plus three compact guesses fits well
 * inside a respond turn's, a guess turn gets room for each guess it asks for, and a model that
 * keeps writing past its last guess is cut off instead of running to the deadline.
 */
export function outputCeiling(turn: LinesTurn): number {
  return turn.kind === "respond" ? 640 : Math.max(520, 160 + 120 * turn.count);
}

/** Called with each line the moment its newline arrives, and with the last line at the end. */
export type LineHandler = (line: string, milliseconds: number) => void;

const countWords = ["no", "one", "two", "three", "four", "five"];

/**
 * The instructions for one world: the line-format system prompt with how many guesses each turn
 * writes, the premise the world started from and its ladder. Identical for every turn of a
 * session, so it caches; how the world is filmed now goes in the context, since turns restate it.
 */
export function linesInstructions(premise: string, world: World, guesses: number): string {
  const canon = world.canon;
  return fill(`${linesPrompt.trim()}\n\n${worldPrompt.trim()}`, {
    guesses: countWords[guesses] ?? String(guesses),
    lookWords: String(lineLimits.look),
    beatWords: String(lineLimits.beat),
    sayWords: String(lineLimits.say),
    printedWords: String(lineLimits.printed),
    frameWords: String(filmLimits.frame),
    styleWords: String(filmLimits.style),
    placeWords: String(filmLimits.place),
    negatives: forbiddenWords.negatives.join(", "),
    pointerWords: forbiddenWords.pointer.join(", "),
    premise,
    ladder: canon.ladder.map((rung, index) => `${index}. ${rung.mood}`).join("\n"),
  });
}

function describeInput(input: AgentInput): string {
  switch (input.kind) {
    case "start":
      return "the session just opened";
    case "click":
      return `picked ${input.elementID} (${input.label})`;
    case "type":
      return `typed ${input.text} into ${input.elementID} (${input.label})`;
    case "instruct":
      return `told you: ${input.text}`;
  }
}

/** How many offstage things the agent sees, most recently introduced first. */
const offstageShown = 16;

/**
 * Things introduced earlier and out of view now, with where they last sat and the look the
 * registry keeps, so the agent can bring one back by its id alone.
 */
function offstage(world: World): string[] {
  return Object.entries(world.registry)
    .filter(([id]) => world.entities[id] === undefined)
    .reverse()
    .slice(0, offstageShown)
    .map(
      ([id, known]) =>
        `${id}, last in ${known.parent ?? "world"} at ${known.place}: ${known.look}${known.words === null ? "" : ` printed ${known.words}`}`,
    );
}

/**
 * How the world is filmed now and its places, then everything the person said in their own
 * words and the story so far: the parts that change least, first, so they cache with the
 * instructions.
 */
function standing(world: World, memory: MemoryContext): string[] {
  const canon = world.canon;
  return [
    "filmed:",
    `- frame: ${canon.frame}`,
    `- approach: ${canon.approach}`,
    `- settle: ${canon.settle}`,
    `- style: ${canon.style}`,
    `- ambient: ${canon.ambient}`,
    ...canon.filler.map((sentence) => `- filler: ${sentence}`),
    "places:",
    ...Object.entries(canon.places).map(([id, place]) => `- ${id}: ${place.phrase}`),
    `directions:${memory.directions.length === 0 ? " (none yet)" : ""}`,
    ...memory.directions,
    `story so far: ${memory.story ?? "(none yet)"}`,
  ];
}

/**
 * The per-turn input: how the world is filmed and what the person said, then the world in view
 * in the agent's own syntax, the offstage things it can bring back, facts, rung, gags, recent and
 * turn.
 */
export function linesContext(world: World, memory: MemoryContext, turn: LinesTurn): string {
  const rung = world.canon.ladder[world.rung];
  const next = world.canon.ladder[world.rung + 1];
  const facts = Object.entries(world.facts).map(([key, value]) => `${key}=${value}`);
  const gags = Object.entries(world.gags).map(([name, text]) => `${name}: ${text}`);
  const away = offstage(world);
  return [
    ...standing(world, memory),
    "world:",
    ...walk(world).map(formatEntity),
    `offstage:${away.length === 0 ? " (none yet)" : ""}`,
    ...away,
    `facts: ${facts.join(", ")}`,
    `rung: ${world.rung} ${rung?.mood ?? ""}${next === undefined ? " (top)" : `; next: ${next.mood}`}`,
    `gags: ${gags.length === 0 ? "(none yet)" : gags.join("; ")}`,
    "recent:",
    ...memory.recent,
    `turn: ${turn.kind}`,
    `input: ${describeInput(turn.input)}`,
    ...(turn.kind === "respond" && turn.problems.length > 0
      ? [`problems: ${turn.problems.join("; ")}`]
      : []),
    ...(turn.kind === "speculate"
      ? [
          `guesses: ${turn.count >= turn.picks.length ? "one for each of" : `the ${countWords[turn.count] ?? String(turn.count)} likeliest of`} ${turn.picks.join(", ")}`,
        ]
      : []),
  ].join("\n");
}

/**
 * Streams one line-format turn as plain text and hands each line over the moment it closes, so
 * the caller can act on the first line that settles the transition. Runs under the agent
 * deadlines; every line is logged with its time since the call started.
 */
export async function streamLines(
  request: LinesRequest,
  onLine: LineHandler,
): Promise<LinesResult> {
  const callID = crypto.randomUUID().slice(0, 8);
  record("agent_call_start", {
    callID,
    turn: request.turn.kind,
    input: request.turn.input,
    format: "lines",
    model: request.model?.name ?? agentModel,
    effort: request.model?.effort ?? "none",
  });
  const instructions = linesInstructions(request.premise, request.world, request.guesses);
  const instructionsHash = saveInstructions(instructions);
  const input = linesContext(request.world, request.memory, request.turn);
  const deadlines = {
    name: "agent",
    firstToken: agentDeadlines.firstToken,
    stall: agentDeadlines.stall,
    completion: agentDeadlines.lines,
  };
  return guarded(callID, request.signal, deadlines, async (signal, onChunk) => {
    const started = performance.now();
    const stream = await getClient(request.openAI).responses.create(
      {
        model: request.model?.name ?? agentModel,
        ...(request.model?.effort === "omit"
          ? {}
          : { reasoning: { effort: request.model?.effort ?? "none" } }),
        instructions,
        input,
        max_output_tokens: outputCeiling(request.turn),
        prompt_cache_key: request.cacheKey,
        stream: true,
      },
      { signal },
    );
    let text = "";
    let pending = "";
    let firstTokenMs: number | null = null;
    let rawUsage: unknown = null;
    const deltas: { ms: number; text: string }[] = [];
    const lines: string[] = [];
    const usage: Pick<LinesResult, "outputTokens" | "inputTokens" | "cachedTokens"> = {
      outputTokens: null,
      inputTokens: null,
      cachedTokens: null,
    };
    const emit = (raw: string) => {
      for (const line of splitGlued(raw)) emitOne(line);
    };
    const emitOne = (line: string) => {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("```")) return;
      const milliseconds = Math.round(performance.now() - started);
      lines.push(trimmed);
      record("agent_line", { callID, line: trimmed, ms: milliseconds });
      onLine(trimmed, milliseconds);
    };
    const finish = () => {
      const doneMs = Math.round(performance.now() - started);
      record("agent_lines_done", {
        callID,
        turn: request.turn.kind,
        aborted: signal.aborted,
        outputChars: text.length,
        instructionsHash,
        input,
        text,
        firstTokenMs,
        doneMs,
        ...usage,
      });
      record("agent_turn", {
        callID,
        format: "lines",
        hint: `${request.turn.kind}|${describeInput(request.turn.input)}`,
        instructionsHash,
        input,
        aborted: signal.aborted,
        deltas,
        doneMs,
        usage: rawUsage,
      });
      return doneMs;
    };
    try {
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") {
          onChunk();
          if (firstTokenMs === null) {
            firstTokenMs = Math.round(performance.now() - started);
            record("agent_first_token", { callID });
          }
          text += event.delta;
          deltas.push({ ms: Math.round(performance.now() - started), text: event.delta });
          pending += event.delta;
          const parts = pending.split("\n");
          pending = parts.pop() ?? "";
          for (const part of parts) if (!signal.aborted) emit(part);
        } else if (event.type === "response.completed" || event.type === "response.incomplete") {
          const reported = event.response.usage;
          rawUsage = reported ?? null;
          usage.outputTokens = reported?.output_tokens ?? null;
          usage.inputTokens = reported?.input_tokens ?? null;
          usage.cachedTokens = reported?.input_tokens_details.cached_tokens ?? null;
          record("agent_usage", { callID, ...usage });
        }
      }
    } catch (error: unknown) {
      finish();
      throw error;
    }
    emit(pending);
    const doneMs = finish();
    return { callID, text, lines, firstTokenMs, doneMs, ...usage };
  });
}
