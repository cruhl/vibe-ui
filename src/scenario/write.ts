import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { agentModel, getClient, guarded, type OpenAIAccess } from "../agent/index.ts";
import {
  forbiddenWord,
  forbiddenWords,
  projectEntity,
  promptBand,
  viewOf,
} from "../projector/index.ts";
import { DeadlineError, record } from "../run-log/index.ts";
import { fill } from "../text/index.ts";
import { Entity, Rung, WorldFile, worldFileOf, worldFromFile, type World } from "../state/index.ts";
import { BusyKit } from "./busy.ts";
import exampleIDs from "./examples.json";
import { folderScenarios } from "./folders.ts";
import { saveScenario } from "./registry.ts";
import repairPrompt from "./repair.md?raw";
import type { SavedScenario, Scenario } from "./scenario.ts";
import writePrompt from "./write.md?raw";

const WrittenWorld = z.object({
  canon: z.object({
    name: z.string(),
    frame: z.string(),
    still: z.string(),
    approach: z.string(),
    arrive: z.string(),
    leave: z.string(),
    settle: z.string(),
    ambient: z.string(),
    selectSound: z.string(),
    lettering: z.string(),
    style: z.string(),
    places: z.array(z.object({ id: z.string(), phrase: z.string(), order: z.number() })),
    ladder: z.array(Rung),
    filler: z.array(z.string()),
  }),
  entities: z.array(Entity),
  facts: z.array(z.object({ key: z.string(), value: z.string() })),
});
type WrittenWorld = z.infer<typeof WrittenWorld>;

const Playable = z.object({ premise: z.string(), world: WrittenWorld });
const Written = Playable.extend({ busy: BusyKit });
const Repaired = z.object({ texts: z.array(z.string()) });

/** Deadlines in milliseconds for the streamed call that writes a scenario and its one repair. */
export const writeDeadlines = {
  firstToken: 12_000,
  stall: 10_000,
  completion: 150_000,
  repair: 10_000,
} as const;

/** Where the stream is: which part of the scenario is arriving now. */
export type WriteStage = "premise" | "world" | "busy" | "done";

/**
 * What a running write reports as it goes: the part arriving now, how much has arrived, the
 * premise as far as it is written, and the world's name once it is.
 */
export interface WriteProgress {
  stage: WriteStage;
  characters: number;
  premise: string;
  name: string | null;
}

/**
 * The text of a JSON string still being streamed, from the first match of `opening` (which ends
 * at the string's opening quote) up to its closing quote or the end of what has arrived, with any
 * escape cut off at the end dropped; null until `opening` has arrived.
 */
export function streamingString(text: string, opening: RegExp): string | null {
  const match = opening.exec(text);
  if (match === null) return null;
  let raw = "";
  for (let i = match.index + match[0].length; i < text.length; i++) {
    const character = text[i] ?? "";
    if (character === '"') break;
    if (character === "\\") {
      const escape = text.slice(i, i + (text[i + 1] === "u" ? 6 : 2));
      if (escape.length < (text[i + 1] === "u" ? 6 : 2)) break;
      raw += escape;
      i += escape.length - 1;
      continue;
    }
    raw += character;
  }
  try {
    const value: unknown = JSON.parse(`"${raw}"`);
    return typeof value === "string" ? value : null;
  } catch {
    return null;
  }
}

const premiseOpening = /^\s*\{\s*"premise"\s*:\s*"/;
const nameOpening = /"canon"\s*:\s*\{\s*"name"\s*:\s*"/;

export interface WriteRequest {
  idea: string;
  openAI: OpenAIAccess;
  signal?: AbortSignal;
  onProgress: (progress: WriteProgress) => void;
  /** Called once, the moment the premise and world exist, before the busy state arrives. */
  onPlayable: (scenario: Scenario) => void;
}

const stages: readonly WriteStage[] = ["premise", "world", "busy"];
const busyStart = /,\s*"busy"\s*:/;

function worldFile(written: WrittenWorld): WorldFile {
  return {
    canon: {
      ...written.canon,
      places: Object.fromEntries(
        written.canon.places.map((place) => [
          place.id,
          { phrase: place.phrase, order: place.order },
        ]),
      ),
    },
    entities: written.entities,
    facts: Object.fromEntries(written.facts.map((fact) => [fact.key, fact.value])),
  };
}

function writtenWorld(world: World): WrittenWorld {
  const file = worldFileOf(world);
  return {
    canon: {
      ...file.canon,
      places: Object.entries(file.canon.places).map(([id, place]) => ({ id, ...place })),
    },
    entities: file.entities,
    facts: Object.entries(file.facts).map(([key, value]) => ({ key, value })),
  };
}

/**
 * The instructions: the writing prompt, the forbidden word lists the projector enforces, then
 * the example folders written out in the same format.
 */
export function writeInstructions(): string {
  const examples = folderScenarios
    .filter((scenario) => exampleIDs.includes(scenario.id))
    .map((scenario) =>
      JSON.stringify({
        premise: scenario.premise,
        world: writtenWorld(scenario.world),
        busy: scenario.busy,
      }),
    );
  return fill(writePrompt.trim(), {
    pointerWords: forbiddenWords.pointer.join(", "),
    negatives: forbiddenWords.negatives.join(", "),
    examples: examples.join("\n\n"),
  });
}

/** A readable id for a written scenario: its name in lowercase words, then a short random tail. */
export function scenarioID(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  return `${words === "" ? "scenario" : words}-${crypto.randomUUID().slice(0, 6)}`;
}

/** One text of a world file that a prompt can carry, with a way to replace it in a copy. */
interface TextSlot {
  text: string;
  set: (text: string) => void;
}

/** Every text in a mutable world file that ends up in a clip prompt. */
function promptTexts(file: WorldFile): TextSlot[] {
  const canon = file.canon;
  const keys = [
    "frame",
    "still",
    "approach",
    "arrive",
    "leave",
    "settle",
    "ambient",
    "selectSound",
    "lettering",
    "style",
  ] as const;
  const optional = (text: string | null, set: (text: string) => void): TextSlot[] =>
    text === null ? [] : [{ text, set }];
  return [
    ...keys.map((key) => ({
      text: canon[key],
      set: (text: string) => {
        canon[key] = text;
      },
    })),
    ...Object.values(canon.places).map((place) => ({
      text: place.phrase,
      set: (text: string) => {
        place.phrase = text;
      },
    })),
    ...canon.ladder.flatMap((rung) => [
      {
        text: rung.ambient,
        set: (text: string) => {
          rung.ambient = text;
        },
      },
      {
        text: rung.sound,
        set: (text: string) => {
          rung.sound = text;
        },
      },
    ]),
    ...canon.filler.map((line, index) => ({
      text: line,
      set: (text: string) => {
        canon.filler[index] = text;
      },
    })),
    ...file.entities.flatMap((entity) => [
      {
        text: entity.look,
        set: (text: string) => {
          entity.look = text;
        },
      },
      ...optional(entity.state, (text) => {
        entity.state = text;
      }),
      ...optional(entity.words, (text) => {
        entity.words = text;
      }),
      ...optional(entity.sound, (text) => {
        entity.sound = text;
      }),
      ...optional(entity.voice, (text) => {
        entity.voice = text;
      }),
    ]),
  ];
}

/** The texts of a world file that hold a word no prompt may contain. */
function offendingTexts(file: WorldFile): { slot: TextSlot; word: string }[] {
  return promptTexts(file).flatMap((slot) => {
    const word = forbiddenWord(slot.text);
    return word === null ? [] : [{ slot, word }];
  });
}

/** What is wrong with a written world before it can be filmed, or an empty list. */
export function worldProblems(file: WorldFile): string[] {
  const problems: string[] = [];
  const checked = WorldFile.safeParse(file);
  if (!checked.success)
    problems.push(
      ...checked.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`),
    );
  const world = worldFromFile(file);
  const places = new Set(Object.keys(file.canon.places));
  for (const entity of file.entities) {
    if (!places.has(entity.place))
      problems.push(`${entity.id} sits in unknown place ${entity.place}`);
    if (entity.parent !== null && world.entities[entity.parent] === undefined)
      problems.push(`${entity.id} has unknown parent ${entity.parent}`);
  }
  if (viewOf(world).elements.length === 0) problems.push("nothing in the world can be chosen");
  for (const { slot, word } of offendingTexts(file)) problems.push(`${slot.text} says ${word}`);
  try {
    const opening = projectEntity(world, { kind: "start" }, world, []);
    if (opening.tokens > promptBand.max) problems.push(`the opening is ${opening.tokens} tokens`);
  } catch (error: unknown) {
    problems.push(String(error));
  }
  return problems;
}

/**
 * Rewrites only the texts of a world that hold a forbidden word, with one small call under its
 * own deadline, and returns the repaired copy; the world is unchanged when nothing offends.
 */
async function repairWords(
  file: WorldFile,
  openAI: OpenAIAccess,
  signal: AbortSignal,
): Promise<WorldFile> {
  const copy = structuredClone(file);
  const offending = offendingTexts(copy);
  if (offending.length === 0) return copy;
  const started = performance.now();
  record("scenario_repair_start", {
    texts: offending.map(({ slot, word }) => ({ text: slot.text, word })),
  });
  const timeout = AbortSignal.timeout(writeDeadlines.repair);
  const response = await getClient(openAI).responses.parse(
    {
      model: agentModel,
      reasoning: { effort: "none" },
      instructions: fill(repairPrompt.trim(), {
        words: [...forbiddenWords.pointer, ...forbiddenWords.negatives].join(", "),
      }),
      input: JSON.stringify({ texts: offending.map(({ slot }) => slot.text) }),
      text: { format: zodTextFormat(Repaired, "repaired") },
    },
    { signal: AbortSignal.any([signal, timeout]) },
  );
  const texts = response.output_parsed?.texts ?? [];
  if (texts.length !== offending.length)
    throw new Error(`the repair returned ${texts.length} texts for ${offending.length}`);
  offending.forEach(({ slot }, index) => {
    slot.set(texts[index] ?? slot.text);
  });
  record("scenario_repaired", {
    milliseconds: Math.round(performance.now() - started),
    texts,
  });
  return copy;
}

/**
 * Writes a whole scenario from one idea with one streamed structured call: premise, world, then
 * the busy state. The moment the world closes it is checked, its forbidden words repaired with
 * one small call, and the scenario saved and handed to `onPlayable`, so a session can start while
 * the busy state is still arriving; it is saved again, complete, when the stream ends. Throws when
 * a deadline is missed or the world cannot be filmed.
 */
export async function writeScenario(request: WriteRequest): Promise<Scenario> {
  const playableFailed = new AbortController();
  const failure: { message: string | null } = { message: null };
  const outer =
    request.signal === undefined
      ? playableFailed.signal
      : AbortSignal.any([request.signal, playableFailed.signal]);
  const started = performance.now();
  const createdAt = new Date().toISOString();
  record("scenario_write_start", { idea: request.idea, model: agentModel });
  const deadlines = {
    name: "scenario",
    firstToken: writeDeadlines.firstToken,
    stall: writeDeadlines.stall,
    completion: writeDeadlines.completion,
  };
  try {
    return await guarded(null, outer, deadlines, (signal, onChunk) =>
      streamScenario(request, signal, onChunk, started, createdAt, (error) => {
        failure.message = String(error);
        playableFailed.abort();
      }),
    );
  } catch (error: unknown) {
    const message =
      error instanceof DeadlineError ? error.message : (failure.message ?? String(error));
    record("scenario_write_failed", { message });
    throw new Error(message, { cause: error });
  }
}

async function streamScenario(
  request: WriteRequest,
  signal: AbortSignal,
  onChunk: () => void,
  started: number,
  createdAt: string,
  onPlayableFailed: (error: unknown) => void,
): Promise<Scenario> {
  const stream = await getClient(request.openAI).responses.create(
    {
      model: agentModel,
      reasoning: { effort: "none" },
      instructions: writeInstructions(),
      input: request.idea,
      text: { format: zodTextFormat(Written, "scenario") },
      prompt_cache_key: "scenario-write",
      stream: true,
    },
    { signal },
  );
  let text = "";
  let stage = 0;
  let saved: Promise<SavedScenario> | null = null;
  for await (const event of stream) {
    if (event.type !== "response.output_text.delta") continue;
    onChunk();
    if (text === "")
      record("scenario_first_token", { milliseconds: Math.round(performance.now() - started) });
    text += event.delta;
    for (let next = stage + 1; next < stages.length; next++)
      if (new RegExp(`[{,]\\s*"${stages[next] ?? ""}"\\s*:`).test(text)) stage = next;
    request.onProgress({
      stage: stages[stage] ?? "busy",
      characters: text.length,
      premise: streamingString(text, premiseOpening) ?? "",
      name: streamingString(text, nameOpening),
    });
    const opened = busyStart.exec(text);
    if (saved === null && opened !== null) {
      const playable = Playable.parse(JSON.parse(`${text.slice(0, opened.index)}}`));
      saved = playableScenario(playable, request, started, createdAt, signal);
      saved.catch(onPlayableFailed);
    }
  }
  if (saved === null) throw new Error("the stream ended before the world");
  const playable = await saved;
  const written = Written.parse(JSON.parse(text));
  const scenario = await saveScenario({
    ...playable,
    files: { ...playable.files, busy: written.busy },
  });
  record("scenario_written", {
    scenarioID: scenario.id,
    milliseconds: Math.round(performance.now() - started),
    characters: text.length,
  });
  request.onProgress({
    stage: "done",
    characters: text.length,
    premise: playable.files.premise,
    name: scenario.name,
  });
  return scenario;
}

async function playableScenario(
  playable: z.infer<typeof Playable>,
  request: WriteRequest,
  started: number,
  createdAt: string,
  signal: AbortSignal,
): Promise<SavedScenario> {
  const world = await repairWords(worldFile(playable.world), request.openAI, signal);
  const problems = worldProblems(world);
  record("scenario_playable", {
    milliseconds: Math.round(performance.now() - started),
    name: world.canon.name,
    problems,
  });
  if (problems.length > 0) throw new Error(`the written world ${problems.join("; ")}`);
  const saved: SavedScenario = {
    id: scenarioID(world.canon.name),
    idea: request.idea,
    createdAt,
    files: { premise: playable.premise, world, busy: null },
  };
  request.onPlayable(await saveScenario(saved));
  return saved;
}
