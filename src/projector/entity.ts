import {
  fillFacts,
  opText,
  resolveWords,
  walk,
  type Entity,
  type Op,
  type View,
  type World,
} from "../state/index.ts";
import type { AgentInput } from "../agent/index.ts";
import { fill, phrase as phraseOf, phrases } from "../text/index.ts";
import phrasingText from "./entity.md?raw";

/** A projected prompt with its estimated token count and how the length band was met. */
export interface Projection {
  prompt: string;
  tokens: number;
  filler: number;
  trimmed: boolean;
}

/**
 * Estimated prompt tokens the projector keeps every prompt inside, so builds reuse warmed text
 * shapes instead of compiling a new one; 2,048 is the model's hard limit.
 */
export const promptBand = { min: 480, max: 680, limit: 2048 } as const;

const phrasing = phrases(phrasingText);

const phrase = (key: string, values: Record<string, string> = {}) =>
  phraseOf(phrasing, "entity.md", key, values);

const wordList = (key: string) =>
  phrase(key)
    .split(",")
    .map((word) => word.trim().toLowerCase())
    .filter((word) => word !== "");
const forbidden = new Set([...wordList("forbidden"), ...wordList("negatives")]);

/**
 * The words no prompt may contain, as listed once in `entity.md`: words that would draw the
 * person's pointer, and negatives, which the model films instead of leaving out.
 */
export const forbiddenWords = {
  pointer: wordList("forbidden"),
  negatives: wordList("negatives"),
} as const;

/** The first word in a text that no prompt may contain, or null when the text is clean. */
export function forbiddenWord(text: string): string | null {
  for (const word of text.toLowerCase().match(/[a-z']+/g) ?? [])
    if (forbidden.has(word)) return word;
  return null;
}

/** The first forbidden word in anything an op would put into a prompt, or null. */
export function forbiddenInOp(op: Op): string | null {
  for (const text of opText(op)) {
    const found = forbiddenWord(text);
    if (found !== null) return found;
  }
  return null;
}

const trimEnd = (text: string) => text.trim().replace(/[.\s]+$/, "");
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);
const upperFirst = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function definite(look: string): string {
  const text = trimEnd(look);
  const match = /^(a|an|the)\s+(.*)$/i.exec(text);
  return match === null ? `the ${lowerFirst(text)}` : `the ${match[2] ?? ""}`;
}

function wordsPart(world: World, entity: Entity): string {
  const words = resolveWords(world, entity);
  if (words === null) return "";
  return phrase("words-part", {
    noun: phrase(/\s/.test(words.trim()) ? "words" : "word"),
    words: words.trim(),
  });
}

function placePhrase(world: World, entity: Entity): string {
  return trimEnd(world.canon.places[entity.place]?.phrase ?? "");
}

function entitySentence(world: World, entity: Entity): string {
  return phrase("entity", {
    place: upperFirst(placePhrase(world, entity)),
    look: lowerFirst(trimEnd(entity.look)),
    state:
      entity.state === null
        ? ""
        : phrase("state-part", { state: trimEnd(fillFacts(world, entity.state)) }),
    words: wordsPart(world, entity),
  });
}

/** The entity with its printed words, as a noun phrase: "the stone button, bearing the word ...". */
function named(world: World, entity: Entity): string {
  const words = wordsPart(world, entity);
  return words === "" ? definite(entity.look) : `${definite(entity.look)}${words},`;
}

/** At most this many changes are narrated in one clip; the rest show in the entity walk. */
const narratedChanges = 5;
/** At most this many beats play through the middle of one clip. */
const narratedBeats = 3;

function changeClause(entity: Entity, state: string | null, words: string | null): string | null {
  if (state !== null && words !== null)
    return phrase("change-both", {
      the: definite(entity.look),
      state: trimEnd(state),
      words,
    });
  if (state !== null)
    return phrase("change-state", { the: definite(entity.look), state: trimEnd(state) });
  if (words !== null) return phrase("change-words", { the: definite(entity.look), words });
  return null;
}

/**
 * Every visible change of a turn as clauses, in the order the agent wrote them: a top-level
 * arrival through the canon's `arrive` (a top-level leave only when nothing arrives in its
 * place), things added or removed inside things that stay, each changed thing once with its
 * last state, and printed facts that changed. Insides of an arriving thing and changes to new
 * things are left to the entity walk.
 */
function changeClauses(before: World, after: World, ops: readonly Op[]): string[] {
  const added = new Set(ops.flatMap((op) => (op.op === "add" ? [op.placement.id] : [])));
  const rootArrives = ops.some(
    (op) => op.op === "add" && after.entities[op.placement.id]?.parent === null,
  );
  const narrated = new Set<string>();
  const clauses = ops.flatMap((op, index): string[] => {
    if (op.op === "add") {
      const entity = after.entities[op.placement.id];
      if (entity === undefined) return [];
      if (entity.parent === null)
        return [
          trimEnd(
            fill(after.canon.arrive, {
              thing: lowerFirst(trimEnd(entity.look)),
              place: lowerFirst(placePhrase(after, entity)),
            }),
          ),
        ];
      if (added.has(entity.parent)) return [];
      return [
        phrase("add", {
          a: lowerFirst(trimEnd(entity.look)),
          place: lowerFirst(placePhrase(after, entity)),
        }),
      ];
    }
    if (op.op === "clear")
      return rootArrives
        ? []
        : walk(before)
            .filter((entity) => entity.parent === null)
            .map((entity) => trimEnd(fill(after.canon.leave, { thing: definite(entity.look) })));
    if (op.op === "remove") {
      const entity = before.entities[op.id];
      if (entity === undefined) return [];
      if (entity.parent === null)
        return rootArrives
          ? []
          : [trimEnd(fill(after.canon.leave, { thing: definite(entity.look) }))];
      if (after.entities[entity.parent] === undefined) return [];
      return [phrase("remove", { the: definite(entity.look) })];
    }
    if (op.op === "change") {
      const entity = after.entities[op.id];
      if (entity === undefined || added.has(op.id)) return [];
      const later = ops.slice(index + 1).some((next) => next.op === "change" && next.id === op.id);
      if (later) return [];
      narrated.add(op.id);
      const clause = changeClause(
        entity,
        op.state === null ? null : fillFacts(after, op.state),
        op.words === undefined ? null : resolveWords(after, entity),
      );
      return clause === null ? [] : [clause];
    }
    if (op.op === "fact") {
      const shown = Object.values(after.entities).find(
        (entity) =>
          (entity.words ?? "").includes(`$${op.key}`) &&
          !added.has(entity.id) &&
          !narrated.has(entity.id),
      );
      const words = shown === undefined ? null : resolveWords(after, shown);
      if (shown === undefined || words === null) return [];
      narrated.add(shown.id);
      return [phrase("change-words", { the: definite(shown.look), words })];
    }
    return [];
  });
  return clauses.slice(0, narratedChanges);
}

/** Clauses joined as one cascade in time: "A", "A, and then B", "A, then B, and then C". */
function sequence(clauses: readonly string[]): string | null {
  const last = clauses.at(-1);
  if (last === undefined) return null;
  if (clauses.length === 1) return last;
  return `${clauses.slice(0, -1).join(`, ${phrase("then")} `)}, ${phrase("and-then")} ${last}`;
}

function beatTexts(world: World, ops: readonly Op[]): string[] {
  return ops
    .flatMap((op) => {
      const text = op.op === "beat" ? op.text : op.op === "gag" ? world.gags[op.name] : undefined;
      return text === undefined ? [] : [lowerFirst(trimEnd(text))];
    })
    .slice(0, narratedBeats);
}

/**
 * One short line saying what visibly changes between two views of the world, for progress displays: the
 * first change, else the first beat, else null.
 */
export function describeChange(before: World, after: World, ops: readonly Op[]): string | null {
  const first = changeClauses(before, after, ops)[0] ?? beatTexts(after, ops)[0];
  return first === undefined ? null : sanitize(upperFirst(first));
}

function beatsSentence(world: World, ops: readonly Op[]): string {
  const beats = sequence(beatTexts(world, ops));
  return beats === null ? "" : sentence(phrase("beats", { beats }));
}

function actionSentence(
  input: AgentInput | null,
  before: World,
  after: World,
  ops: readonly Op[],
): string {
  if (input?.kind === "start") return after.canon.still;
  const change = sequence(changeClauses(before, after, ops));
  if (input === null) return change === null ? "" : phrase("instruct", { change });
  if (input.kind === "instruct")
    return change === null ? phrase("instruct-alone") : phrase("instruct", { change });
  if (input.kind === "point") {
    const added = ops
      .flatMap((op) =>
        op.op === "add" && before.registry[op.placement.id] === undefined
          ? [after.entities[op.placement.id]]
          : [],
      )
      .find((entity) => entity?.control === "pick");
    const seen = input.thingID === null ? undefined : before.entities[input.thingID];
    const thing = added ?? (seen?.parent == null ? undefined : seen);
    if (thing === undefined)
      return change === null ? phrase("instruct-alone") : phrase("instruct", { change });
    const approach = trimEnd(fill(before.canon.approach, { thing: named(after, thing) }));
    return change === null ? approach : phrase("pick", { approach, change });
  }
  if (input.kind === "field") {
    const added = ops
      .flatMap((op) =>
        op.op === "add" && before.registry[op.placement.id] === undefined
          ? [after.entities[op.placement.id]]
          : [],
      )
      .find((entity) => entity?.control === "input");
    const seen = input.thingID === null ? undefined : before.entities[input.thingID];
    const target =
      added !== undefined
        ? named(after, added)
        : seen !== undefined
          ? named(before, seen)
          : definite(input.label);
    return change === null
      ? phrase("type-alone", { text: input.text, target })
      : phrase("type", { text: input.text, target, change });
  }
  const entity = before.entities[input.elementID] ?? after.entities[input.elementID];
  const target = entity === undefined ? definite(input.label) : named(before, entity);
  if (input.kind === "type")
    return change === null
      ? phrase("type-alone", { text: input.text, target })
      : phrase("type", { text: input.text, target, change });
  const approach = trimEnd(fill(before.canon.approach, { thing: target }));
  return change === null ? approach : phrase("pick", { approach, change });
}

function sentence(text: string): string {
  const trimmed = trimEnd(text);
  return trimmed === "" ? "" : `${upperFirst(trimmed)}.`;
}

function speech(world: World, ops: readonly Op[]): string[] {
  return ops.flatMap((op) => {
    if (op.op !== "say") return [];
    const entity = world.entities[op.id];
    if (entity?.voice == null) return [];
    return [
      phrase("say", {
        voice: trimEnd(entity.voice),
        the: definite(entity.look),
        words: trimEnd(op.text),
      }),
    ];
  });
}

function soundscape(after: World, input: AgentInput | null, ops: readonly Op[]): string {
  const rung = after.canon.ladder[after.rung];
  const sounds = [
    ...speech(after, ops),
    ...ops.flatMap((op) => (op.op === "sound" ? [op.text] : [])),
    ...walk(after).flatMap((entity) => (entity.sound === null ? [] : [entity.sound])),
    ...(after.rung > 0 && rung !== undefined && rung.sound !== "" ? [rung.sound] : []),
  ];
  return phrase("soundscape", {
    ambient: sentence(after.canon.ambient),
    select:
      input?.kind === "click" || input?.kind === "point" ? sentence(after.canon.selectSound) : "",
    sounds: sounds.map(sentence).join(" "),
  });
}

/** Removes dashes and quotation marks and collapses spaces, the last step before every prompt. */
export function sanitize(text: string): string {
  return text
    .replace(/[‐-―−]/g, " ")
    .replace(/(\S)-(?=\S)/g, "$1 ")
    .replace(/\s-\s/g, " ")
    .replace(/["“”‘’]/g, (mark) => (mark === "’" ? "'" : ""))
    .replace(/[ \t]+/g, " ")
    .replace(/ +([.,])/g, "$1")
    .trim();
}

/** Estimated tokens of a prompt: about four characters each, the same for every projector. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

function assemble(description: string[], sound: string): string {
  return sanitize(
    `integrated_multimodal_description: ${description.filter((part) => part !== "").join(" ")}\n\noverall_soundscape: ${sound}\n\nnon_diegetic_music: ${phrase("music")}`,
  )
    .split("\n")
    .map((line) => line.trim())
    .join("\n");
}

/**
 * Projects a world and the ops that led to it into the full H3 prompt: opener, the approach and
 * every change of the turn as one cascade, the beats through the middle, the settle in the last
 * second, every entity in paint order, the
 * composition, the world's lettering once when anything in view is printed, the rung, filler,
 * and the style spine last, then the soundscape with any speech. Pads with the world's filler
 * sentences up to the band and drops the rung's ambient first when over. A clip a follow-up
 * continues (`rests` false) leaves out the settle and stays in motion to its last frame; a null
 * input is a follow-up itself, carrying straight on from its parent's clip with no approach.
 */
export function projectEntity(
  after: World,
  input: AgentInput | null,
  before: World,
  ops: readonly Op[],
  rests = true,
): Projection {
  const canon = after.canon;
  const rung = canon.ladder[after.rung];
  const core = [
    phrase("opener", { frame: trimEnd(canon.frame) }),
    sentence(actionSentence(input, before, after, ops)),
    beatsSentence(after, ops),
    input?.kind === "start" || !rests ? "" : sentence(canon.settle),
    ...walk(after).map((entity) => entitySentence(after, entity)),
    phrase("composition"),
    walk(after).some((entity) => resolveWords(after, entity) !== null)
      ? phrase("lettering", { lettering: trimEnd(canon.lettering) })
      : "",
  ];
  const style = sentence(canon.style);
  const ambient =
    after.rung > 0 && rung !== undefined && rung.ambient !== ""
      ? sentence(phrase("ambient-rung", { ambient: rung.ambient }))
      : "";
  const sound = soundscape(after, input, ops);
  let filler = 0;
  let prompt = assemble([...core, ambient, style], sound);
  while (estimateTokens(prompt) < promptBand.min && filler < canon.filler.length) {
    filler++;
    prompt = assemble(
      [...core, ambient, ...canon.filler.slice(0, filler).map(sentence), style],
      sound,
    );
  }
  let trimmed = false;
  if (estimateTokens(prompt) > promptBand.max && ambient !== "") {
    trimmed = true;
    prompt = assemble([...core, style], sound);
  }
  const tokens = estimateTokens(prompt);
  if (tokens > promptBand.limit) throw new Error(`prompt is ${tokens} tokens, over the limit`);
  return { prompt, tokens, filler, trimmed };
}

/**
 * The view every other domain reads: clickable entities as elements with a look sentence for Jev,
 * facts as a list, and the world walk as one paragraph.
 */
export function viewOf(world: World): View {
  const entities = walk(world);
  return {
    name: world.canon.name,
    scene: sanitize(entities.map((entity) => entitySentence(world, entity)).join(" ")),
    elements: entities.flatMap((entity) =>
      entity.control === null
        ? []
        : [
            {
              id: entity.id,
              kind: entity.control,
              label: (resolveWords(world, entity) ?? trimEnd(entity.look)).toUpperCase(),
              look: sanitize(entitySentence(world, entity)),
            },
          ],
    ),
    facts: Object.entries(world.facts).map(([key, value]) => ({ key, value })),
    world: world,
  };
}

/** The prompt that opens a world as it is, with nothing chosen yet. */
export function openingPrompt(world: World): string {
  return projectEntity(world, { kind: "start" }, world, []).prompt;
}
