import { z } from "zod";
import { hashText } from "../text/index.ts";

/** `pick` for anything the person can choose, `input` for anything that takes typed text. */
export const Control = z.enum(["pick", "input"]);
export type Control = z.infer<typeof Control>;

/**
 * One thing in the world. `look` is permanent and never rewritten; `state` is its visible state, the
 * usual patch target; `words` is the text printed on it, which may embed `$fact`.
 */
export const Entity = z.object({
  id: z.string(),
  parent: z.string().nullable(),
  place: z.string(),
  look: z.string(),
  state: z.string().nullable(),
  words: z.string().nullable(),
  control: Control.nullable(),
  sound: z.string().nullable(),
  voice: z.string().nullable(),
});
export type Entity = z.infer<typeof Entity>;

/**
 * What the world remembers of a thing once it has been introduced, whether or not it is in view:
 * where it last sat and how it last looked there, its permanent look, printed words, control,
 * sound and voice. Re-adding a known id takes
 * these back, so a thing that leaves and returns looks the same as when it left.
 */
export const Known = Entity.pick({
  parent: true,
  place: true,
  look: true,
  state: true,
  words: true,
  control: true,
  sound: true,
  voice: true,
});
export type Known = z.infer<typeof Known>;

/** The registry entry an entity leaves behind, with where it last sat. */
export const knownOf = (entity: Entity): Known => ({
  parent: entity.parent,
  place: entity.place,
  look: entity.look,
  state: entity.state,
  words: entity.words,
  control: entity.control,
  sound: entity.sound,
  voice: entity.voice,
});

/** A named spot in the world: the phrase that opens its sentence and its paint order. */
export const Place = z.object({ phrase: z.string(), order: z.number() });
export type Place = z.infer<typeof Place>;

/** One rung of the escalation ladder: the agent reads `mood`; `ambient` and `sound` enter prompts. */
export const Rung = z.object({ mood: z.string(), ambient: z.string(), sound: z.string() });
export type Rung = z.infer<typeof Rung>;

const withSlots = (slots: readonly string[]) =>
  z.string().refine((text) => slots.every((slot) => text.includes(`{${slot}}`)), {
    message: `must contain ${slots.map((slot) => `{${slot}}`).join(" and ")}`,
  });

/**
 * What an LLM writes once per world and every prompt reuses: how it is filmed, how it moves and
 * sounds, and where things can sit. The sentence templates hold the only phrasing that depends on
 * the kind of world; code fills `{thing}` (and `{place}` in `arrive`, where it is optional) and
 * nothing else.
 */
export const Canon = z.object({
  name: z.string(),
  frame: z.string(),
  still: z.string(),
  approach: withSlots(["thing"]),
  arrive: withSlots(["thing"]),
  leave: withSlots(["thing"]),
  settle: z.string(),
  ambient: z.string(),
  selectSound: z.string(),
  lettering: z.string(),
  style: z.string().refine(
    (text) => {
      const count = text.split(/\s+/).filter((word) => word !== "").length;
      return count >= 3 && count <= 8;
    },
    { message: "must be three to eight words of medium and color" },
  ),
  places: z.record(z.string(), Place),
  ladder: z.array(Rung).min(1),
  filler: z.array(z.string()),
});
export type Canon = z.infer<typeof Canon>;

/**
 * The whole world as entities: what the projector turns into a prompt every clip. `entities` are
 * the things in view; `registry` is every thing ever introduced, by id, and outlives removal.
 */
export const World = z.object({
  canon: Canon,
  entities: z.record(z.string(), Entity),
  registry: z.record(z.string(), Known),
  order: z.array(z.string()),
  facts: z.record(z.string(), z.string()),
  rung: z.number().int().nonnegative(),
  gags: z.record(z.string(), z.string()),
});
export type World = z.infer<typeof World>;

/** A world's starting state as written in its `world.json`: entities as an ordered list. */
export const WorldFile = z.object({
  canon: Canon,
  entities: z.array(Entity),
  facts: z.record(z.string(), z.string()),
});
export type WorldFile = z.infer<typeof WorldFile>;

/** Builds the starting world from its file. */
export function worldFromFile(file: WorldFile): World {
  return {
    canon: file.canon,
    entities: Object.fromEntries(file.entities.map((entity) => [entity.id, entity])),
    registry: Object.fromEntries(file.entities.map((entity) => [entity.id, knownOf(entity)])),
    order: file.entities.map((entity) => entity.id),
    facts: file.facts,
    rung: 0,
    gags: {},
  };
}

/** The file form of a world: its starting canon, entities in arrival order, and facts. */
export function worldFileOf(world: World): WorldFile {
  return {
    canon: world.canon,
    entities: world.order.flatMap((id) => {
      const entity = world.entities[id];
      return entity === undefined ? [] : [entity];
    }),
    facts: world.facts,
  };
}

/**
 * Entities in paint order: top-level ones by place order then by arrival, each followed by its
 * children the same way, depth first.
 */
export function walk(world: World): Entity[] {
  const arrival = new Map(world.order.map((id, index) => [id, index]));
  const placeOrder = (entity: Entity) => world.canon.places[entity.place]?.order ?? 0;
  const childrenOf = (parent: string | null) =>
    Object.values(world.entities)
      .filter((entity) => entity.parent === parent)
      .sort(
        (first, second) =>
          placeOrder(first) - placeOrder(second) ||
          (arrival.get(first.id) ?? 0) - (arrival.get(second.id) ?? 0),
      );
  const visit = (parent: string | null): Entity[] =>
    childrenOf(parent).flatMap((entity) => [entity, ...visit(entity.id)]);
  return visit(null);
}

/** A text with every `$fact` it names filled in from the world's facts. */
export function fillFacts(world: World, text: string): string {
  return text.replace(/\$([a-z][\w.]*)/gi, (whole, key: string) => world.facts[key] ?? whole);
}

/** The printed words of an entity with every `$fact` filled in, or null when it has none. */
export function resolveWords(world: World, entity: Entity): string | null {
  return entity.words === null ? null : fillFacts(world, entity.words);
}

/**
 * One canonical hash of what the world shows: entities in paint order with their visible fields,
 * resolved words, and the rung. Two worlds that would project the same picture hash the same.
 */
export function hashWorld(world: World): string {
  const visible = walk(world).map((entity) => [
    entity.id,
    entity.parent,
    entity.place,
    entity.look,
    entity.state,
    resolveWords(world, entity),
    entity.control,
  ]);
  return hashText(JSON.stringify([visible, world.rung]));
}
