import { Control, knownOf, type Entity, type World } from "./world.ts";

/**
 * A thing placed in the world by a `+` line. For a known id everything but the id may be left
 * out: `parent` and `place` are undefined when unwritten and fall back to where it last sat, and
 * `look` is null because the registry supplies it. `words`, `control` and `voice` fall back to
 * the known ones when null.
 */
export interface Placement {
  id: string;
  parent: string | null | undefined;
  place: string | undefined;
  control: Control | null;
  look: string | null;
  words: string | null;
  state: string | null;
  voice: string | null;
}

/**
 * The parts of how a world is filmed that a `#` line restates, with the most words each may have:
 * the shot itself, the approach to a chosen thing, how a new top-level thing arrives and how one
 * leaves, the last second's settle, the style spine, the lettering, the ambient sound, the sound
 * of a choice, one more filler sentence, and the phrase of one place, new or known.
 */
export const filmLimits = {
  frame: 60,
  approach: 20,
  arrive: 25,
  leave: 16,
  settle: 35,
  style: 8,
  lettering: 16,
  ambient: 25,
  select: 14,
  filler: 20,
  place: 16,
} as const;
export type FilmField = keyof typeof filmLimits;
const isFilmField = (field: string): field is FilmField => Object.hasOwn(filmLimits, field);
/** The slots each sentence template must hold, and the ones it may. */
const templateSlots: Partial<Record<FilmField, { must: string[]; may: string[] }>> = {
  approach: { must: ["thing"], may: [] },
  arrive: { must: ["thing"], may: ["place"] },
  leave: { must: ["thing"], may: [] },
};

function slotProblem(field: FilmField, text: string): string | null {
  const slots = templateSlots[field];
  const used = [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "");
  if (slots === undefined)
    return used.length === 0 ? null : `#${field} takes no {slot}, only plain words`;
  const missing = slots.must.find((slot) => !used.includes(slot));
  if (missing !== undefined) return `#${field} must name the thing as {${missing}}`;
  const stray = used.find((slot) => !slots.must.includes(slot) && !slots.may.includes(slot));
  return stray === undefined ? null : `#${field} has no {${stray}} slot`;
}

/** The most filler sentences a world keeps once it is remade. */
const fillerKept = 4;

/** One agent line, parsed. */
export type Op =
  | { op: "change"; id: string; state: string | null; words: string | null | undefined }
  | { op: "fact"; key: string; value: string }
  | { op: "add"; placement: Placement }
  | { op: "remove"; id: string }
  | { op: "clear" }
  | { op: "beat"; name: string | null; text: string }
  | { op: "climb" }
  | { op: "gag"; name: string }
  | { op: "sound"; text: string }
  | { op: "say"; id: string; text: string }
  | { op: "film"; field: FilmField; place: string | null; text: string }
  | { op: "guess"; elementID: string; likelihood: number | null }
  | { op: "follow" };

export type Parsed = { ok: true; op: Op } | { ok: false; error: string };
export type Applied = { ok: true; world: World } | { ok: false; error: string };

/**
 * The most words a look, a beat, a spoken line and a printed label may have. The agent's prompt
 * states these same numbers; a line over one is rejected.
 */
export const lineLimits = { look: 20, beat: 20, say: 20, printed: 3 } as const;
const idPattern = /^[a-z][a-z0-9.]*(?:-[a-z0-9.]+)*$/;

/**
 * The most `pick` and `input` things a world keeps in view at once; places, fixtures and props
 * never count. Loose enough that every preset's starting world has room for a full window of
 * picks; the prompt aims lower and states this same number as the hard ceiling.
 */
export const viewLimits = { picks: 12 } as const;

const pickCount = (world: World) =>
  Object.values(world.entities).filter((entity) => entity.control !== null).length;

/**
 * Why a change crowds the view, or null: it leaves more picks in view than before, and more than
 * `viewLimits` allows. A world already over the ceiling may still shrink toward it.
 */
export function crowding(before: World, after: World): string | null {
  const picks = pickCount(after);
  return picks > viewLimits.picks && picks > pickCount(before)
    ? `the view would hold ${picks} picks, over ${viewLimits.picks}; first remove with -id what has played its part`
    : null;
}

/**
 * Why printed words are malformed: opening in lowercase, the mark of a state phrase written into
 * the words slot, or too long to be a label. Their case is otherwise the world's lettering.
 */
function checkWords(words: string | null | undefined): string | null {
  if (words === null || words === undefined) return null;
  const bare = words.replace(/\$[a-z][\w.]*/gi, "").trim();
  if (/^[a-z]/.test(bare)) return "printed words must start with a capital letter or a digit";
  if (wordCount(words) > lineLimits.printed)
    return `printed words over ${lineLimits.printed} words`;
  return null;
}

const wordCount = (text: string) => text.split(/\s+/).filter((word) => word !== "").length;
const blank = (text: string | undefined) =>
  text === undefined || text.trim() === "" ? null : text.trim();

function parseAdd(rest: string): Parsed {
  const [head = "", look, words, state, voice] = rest.split("|").map((part) => part.trim());
  const [id = "", parent, place, control, ...extra] = head.split(/\s+/);
  if (extra.length > 0 || id === "") return { ok: false, error: "add needs an id" };
  const parsedControl = control === undefined ? null : Control.safeParse(control);
  if (parsedControl !== null && !parsedControl.success)
    return { ok: false, error: `control must be pick or input, not ${control}` };
  return {
    ok: true,
    op: {
      op: "add",
      placement: {
        id,
        parent: parent === undefined ? undefined : parent === "world" ? null : parent,
        place,
        control: parsedControl === null ? null : parsedControl.data,
        look: blank(look),
        words: blank(words),
        state: blank(state),
        voice: blank(voice),
      },
    },
  };
}

function parseFilm(rest: string): Parsed {
  const match = /^([a-z]+)\s+(.+)$/.exec(rest);
  const field = match?.[1] ?? "";
  if (match === null || !isFilmField(field))
    return { ok: false, error: `# restates one of ${Object.keys(filmLimits).join(", ")}` };
  const text = (match[2] ?? "").trim();
  if (field !== "place") return { ok: true, op: { op: "film", field, place: null, text } };
  const placed = /^(\S+)\s+(.+)$/.exec(text);
  if (placed === null) return { ok: false, error: "#place needs a place id and its phrase" };
  return {
    ok: true,
    op: { op: "film", field, place: placed[1] ?? "", text: (placed[2] ?? "").trim() },
  };
}

/**
 * Restates part of how the world is filmed. A new frame also drops the filler and the ladder's
 * ambient and sound, which were written for the old one.
 */
function film(world: World, op: Extract<Op, { op: "film" }>): Applied {
  const limit = filmLimits[op.field];
  const count = wordCount(op.text);
  if (count > limit) return { ok: false, error: `#${op.field} over ${limit} words` };
  if (op.field === "style" && count < 3) return { ok: false, error: "#style needs three words" };
  const problem = slotProblem(op.field, op.text);
  if (problem !== null) return { ok: false, error: problem };
  const canon = world.canon;
  const next = ((): World["canon"] | string => {
    switch (op.field) {
      case "frame":
        return {
          ...canon,
          frame: op.text,
          filler: [],
          ladder: canon.ladder.map((rung) => ({ ...rung, ambient: "", sound: "" })),
        };
      case "approach":
        return { ...canon, approach: op.text };
      case "arrive":
        return { ...canon, arrive: op.text };
      case "leave":
        return { ...canon, leave: op.text };
      case "select":
        return { ...canon, selectSound: op.text };
      case "lettering":
        return { ...canon, lettering: op.text };
      case "settle":
        return { ...canon, settle: op.text };
      case "style":
        return { ...canon, style: op.text };
      case "ambient":
        return { ...canon, ambient: op.text };
      case "filler":
        return { ...canon, filler: [...canon.filler, op.text].slice(-fillerKept) };
      case "place": {
        const id = op.place ?? "";
        if (!idPattern.test(id)) return `bad place id ${id}`;
        const order =
          canon.places[id]?.order ??
          Math.max(0, ...Object.values(canon.places).map((place) => place.order)) + 1;
        return { ...canon, places: { ...canon.places, [id]: { phrase: op.text, order } } };
      }
    }
  })();
  return typeof next === "string"
    ? { ok: false, error: next }
    : { ok: true, world: { ...world, canon: next } };
}

/**
 * Parses one line of the agent's diff format. Each op is one line: `~id state | WORDS`, `=key
 * value`, `+id parent place [pick|input] | look | WORDS | state | voice`, `-id`, `-*` (everything
 * in view), `! beat`,
 * `!name beat`, `^`, `*name`, `> sound`, `%id spoken words`, `#field text` (`#place id phrase`),
 * the guess header `? id likelihood` and the follow-up header `&`.
 */
export function parseLine(raw: string): Parsed {
  const line = raw.trim();
  const sigil = line.charAt(0);
  const rest = line.slice(1).trim();
  switch (sigil) {
    case "~": {
      const [head = "", words] = rest.split("|");
      const match = /^(\S+)\s*(.*)$/.exec(head.trim());
      if (match === null) return { ok: false, error: "change needs an id" };
      return {
        ok: true,
        op: {
          op: "change",
          id: match[1] ?? "",
          state: blank(match[2]),
          words: words === undefined ? undefined : blank(words),
        },
      };
    }
    case "=": {
      const match = /^(\S+)\s+(.+)$/.exec(rest);
      if (match === null) return { ok: false, error: "fact needs a key and a value" };
      return { ok: true, op: { op: "fact", key: match[1] ?? "", value: (match[2] ?? "").trim() } };
    }
    case "+":
      return parseAdd(rest);
    case "-": {
      if (rest === "*") return { ok: true, op: { op: "clear" } };
      const [id = ""] = rest.split(/\s+/);
      return id === ""
        ? { ok: false, error: "remove takes one id" }
        : { ok: true, op: { op: "remove", id } };
    }
    case "!": {
      const named = /^!(\S+)\s+(.+)$/.exec(line);
      const text = named === null ? rest : (named[2] ?? "");
      if (text === "") return { ok: false, error: "beat needs a sentence" };
      return {
        ok: true,
        op: { op: "beat", name: named === null ? null : (named[1] ?? null), text },
      };
    }
    case "^":
      return rest === ""
        ? { ok: true, op: { op: "climb" } }
        : { ok: false, error: "^ stands alone" };
    case "*":
      return rest === "" || /\s/.test(rest)
        ? { ok: false, error: "* takes one gag name" }
        : { ok: true, op: { op: "gag", name: rest } };
    case "%": {
      const match = /^(\S+)\s+(.+)$/.exec(rest);
      if (match === null) return { ok: false, error: "% needs an id and the words spoken" };
      return { ok: true, op: { op: "say", id: match[1] ?? "", text: (match[2] ?? "").trim() } };
    }
    case ">":
      return rest === ""
        ? { ok: false, error: "sound needs a phrase" }
        : { ok: true, op: { op: "sound", text: rest } };
    case "#":
      return parseFilm(rest);
    case "&":
      return rest === ""
        ? { ok: true, op: { op: "follow" } }
        : { ok: false, error: "& stands alone" };
    case "?": {
      const [elementID = "", likelihood] = rest.split(/\s+/);
      if (elementID === "") return { ok: false, error: "guess needs an element id" };
      const value = likelihood === undefined ? null : Number(likelihood);
      return {
        ok: true,
        op: {
          op: "guess",
          elementID,
          likelihood: value === null || Number.isNaN(value) ? null : value,
        },
      };
    }
    default:
      return { ok: false, error: `unknown line: ${line.slice(0, 40)}` };
  }
}

function removeTree(world: World, id: string): World {
  const doomed = new Set([id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const entity of Object.values(world.entities))
      if (entity.parent !== null && doomed.has(entity.parent) && !doomed.has(entity.id)) {
        doomed.add(entity.id);
        grew = true;
      }
  }
  return {
    ...world,
    entities: Object.fromEntries(
      Object.entries(world.entities).filter(([key]) => !doomed.has(key)),
    ),
    registry: {
      ...world.registry,
      ...Object.fromEntries(
        Object.values(world.entities)
          .filter((entity) => doomed.has(entity.id))
          .map((entity) => [entity.id, knownOf(entity)]),
      ),
    },
    order: world.order.filter((key) => !doomed.has(key)),
  };
}

/**
 * The entity a placement puts into the world, or why it cannot: a new id must bring its look, and
 * a known id must not, because the registry keeps the look it was introduced with.
 */
function placed(world: World, placement: Placement): Entity | string {
  if (!idPattern.test(placement.id)) return `bad id ${placement.id}`;
  const known = world.registry[placement.id];
  const same = (first: string, second: string) =>
    first
      .trim()
      .replace(/[.\s]+$/, "")
      .toLowerCase() ===
    second
      .trim()
      .replace(/[.\s]+$/, "")
      .toLowerCase();
  if (known !== undefined && placement.look !== null && !same(known.look, placement.look))
    return `${placement.id} is already known; bring it back with +${placement.id} and no look`;
  if (known === undefined && placement.look === null)
    return `${placement.id} is new and needs a look`;
  const parent = placement.parent === undefined ? known?.parent : placement.parent;
  const place = placement.place ?? known?.place;
  if (parent === undefined || place === undefined) return "add needs id parent place";
  return {
    id: placement.id,
    parent,
    place,
    look: known?.look ?? placement.look ?? "",
    state: placement.state ?? known?.state ?? null,
    words: placement.words ?? known?.words ?? null,
    control: placement.control ?? known?.control ?? null,
    sound: known?.sound ?? null,
    voice: known === undefined ? placement.voice : known.voice,
  };
}

function checkAdd(world: World, entity: Entity): string | null {
  if (world.entities[entity.id] !== undefined) return `${entity.id} already exists`;
  if (entity.parent !== null && world.entities[entity.parent] === undefined)
    return `unknown parent ${entity.parent}`;
  if (world.canon.places[entity.place] === undefined) return `unknown place ${entity.place}`;
  if (wordCount(entity.look) > lineLimits.look) return `look over ${lineLimits.look} words`;
  return checkWords(entity.words);
}

/**
 * Applies one op to a world and returns the new world, never mutating the old one. Rejects
 * impossible states such as unknown ids and unknown places. Two things never sit in one spot: a
 * thing added where a sibling sits replaces it, and the sibling leaves with everything inside it.
 */
export function applyOp(world: World, op: Op): Applied {
  switch (op.op) {
    case "change": {
      const entity = world.entities[op.id];
      if (entity === undefined) return { ok: false, error: `unknown id ${op.id}` };
      if (op.state === null && op.words === undefined)
        return { ok: false, error: "change needs a state or words" };
      const wordsError = checkWords(op.words);
      if (wordsError !== null) return { ok: false, error: wordsError };
      const next: Entity = {
        ...entity,
        state: op.state ?? entity.state,
        words: op.words === undefined ? entity.words : op.words,
      };
      return { ok: true, world: { ...world, entities: { ...world.entities, [op.id]: next } } };
    }
    case "fact":
      return { ok: true, world: { ...world, facts: { ...world.facts, [op.key]: op.value } } };
    case "add": {
      const entity = placed(world, op.placement);
      if (typeof entity === "string") return { ok: false, error: entity };
      const taken = Object.values(world.entities).find(
        (other) =>
          other.id !== entity.id && other.parent === entity.parent && other.place === entity.place,
      );
      const cleared = taken === undefined ? world : removeTree(world, taken.id);
      const error = checkAdd(cleared, entity);
      if (error !== null) return { ok: false, error };
      return {
        ok: true,
        world: {
          ...cleared,
          entities: { ...cleared.entities, [entity.id]: entity },
          registry: { ...cleared.registry, [entity.id]: knownOf(entity) },
          order: [...cleared.order, entity.id],
        },
      };
    }
    case "say": {
      const entity = world.entities[op.id];
      if (entity === undefined) return { ok: false, error: `unknown id ${op.id}` };
      if (entity.voice === null) return { ok: false, error: `${op.id} has no voice` };
      if (wordCount(op.text) > lineLimits.say)
        return { ok: false, error: `spoken words over ${lineLimits.say} words` };
      return { ok: true, world };
    }
    case "remove":
      return world.entities[op.id] === undefined
        ? { ok: false, error: `unknown id ${op.id}` }
        : { ok: true, world: removeTree(world, op.id) };
    case "clear":
      return {
        ok: true,
        world: Object.values(world.entities)
          .filter((entity) => entity.parent === null)
          .reduce((cleared, entity) => removeTree(cleared, entity.id), world),
      };
    case "beat":
      if (wordCount(op.text) > lineLimits.beat)
        return { ok: false, error: `beat over ${lineLimits.beat} words` };
      return op.name === null
        ? { ok: true, world }
        : { ok: true, world: { ...world, gags: { ...world.gags, [op.name]: op.text } } };
    case "climb":
      return world.rung + 1 >= world.canon.ladder.length
        ? { ok: false, error: "already on the top rung" }
        : { ok: true, world: { ...world, rung: world.rung + 1 } };
    case "gag":
      return world.gags[op.name] === undefined
        ? { ok: false, error: `unknown gag ${op.name}` }
        : { ok: true, world };
    case "sound":
      return { ok: true, world };
    case "film":
      return film(world, op);
    case "guess":
      return { ok: false, error: "a guess header is not a change" };
    case "follow":
      return { ok: false, error: "a follow-up header is not a change" };
  }
}

/** Facts named in printed words that no fact defines, which would print as `$key`. */
export function unresolvedFacts(world: World): string[] {
  return Object.values(world.entities).flatMap((entity) =>
    [...(entity.words ?? "").matchAll(/\$([a-z][\w.]*)/gi)]
      .map((match) => match[1] ?? "")
      .filter((key) => world.facts[key] === undefined),
  );
}

/** One entity in the same `+` syntax the agent writes, so its context reads like its output. */
export function formatEntity(entity: Entity): string {
  const head = [entity.id, entity.parent ?? "world", entity.place, entity.control]
    .filter((part) => part !== null)
    .join(" ");
  const tail = [entity.look, entity.words ?? "", entity.state ?? "", entity.voice ?? ""];
  while (tail.length > 1 && tail.at(-1) === "") tail.pop();
  return `+${head} | ${tail.join(" | ")}`;
}

/** Text the agent wrote inside an op, for the projector's word checks. */
export function opText(op: Op): string[] {
  switch (op.op) {
    case "change":
      return [op.state ?? "", op.words ?? ""];
    case "add":
      return [
        op.placement.look ?? "",
        op.placement.words ?? "",
        op.placement.state ?? "",
        op.placement.voice ?? "",
      ];
    case "say":
      return [op.text];
    case "beat":
      return [op.text];
    case "sound":
      return [op.text];
    case "film":
      return [op.text];
    case "fact":
      return [op.value];
    default:
      return [];
  }
}
