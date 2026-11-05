import type { AgentInput } from "../agent/index.ts";
import { forbiddenInOp, projectEntity, viewOf } from "../projector/index.ts";
import { Draft, hashWorld, parseLine, type Op, type View, type World } from "../state/index.ts";
import { BakedTree, type BakedMoment, type BakeHashes } from "./manifest.ts";
import { momentKey } from "./moment.ts";

/** A baked moment that still holds, with its world replayed from the root. */
export interface LoadedMoment {
  record: BakedMoment;
  world: World;
  state: View;
  ops: Op[];
}

/** What a saved tree is worth against the scenario and the code as they are now. */
export interface TreeCheck {
  moments: LoadedMoment[];
  /** Keys of moments dropped, each with its subtree, and why. */
  stale: string[];
  /** The premise, world or canon changed: nothing in the tree is used. */
  rootStale: boolean;
  /** The agent instructions changed since the bake: the tree is served and marked behind. */
  behind: boolean;
  /** The Jev model changed since the bake: the held frames should be boxed again. */
  rebox: boolean;
}

function transition(record: BakedMoment): AgentInput {
  const input = record.input;
  if (input === null) return { kind: "start" };
  return input.action === "type"
    ? { kind: "type", elementID: input.elementID, label: record.label, text: input.text ?? "" }
    : { kind: "click", elementID: input.elementID, label: record.label };
}

/**
 * Checks a saved tree by content, never by date. The root's key must match the premise, world
 * and opening as they are now, or the whole tree is stale. Every other moment, parents first, is
 * replayed from its parent's world through its lines with the same code the agent path uses: its
 * key, its state hash and its re-projected prompt (with its stored picture labels) must all match,
 * or it is dropped with everything below it.
 */
export function checkTree(raw: unknown, root: World, current: BakeHashes): TreeCheck {
  const parsed = BakedTree.safeParse(raw);
  const empty = { moments: [], behind: false, rebox: false };
  if (!parsed.success) return { ...empty, stale: ["tree.json does not parse"], rootStale: true };
  const tree = parsed.data;
  const first = tree.moments[0];
  if (tree.hashes.root !== current.root || first?.key !== current.root || first.parentKey !== null)
    return { ...empty, stale: [tree.hashes.root], rootStale: true };
  const loaded = new Map<string, LoadedMoment>();
  const stale: string[] = [];
  const rootState = viewOf(root);
  if (first.stateHash !== hashWorld(root))
    return { ...empty, stale: [`${first.key}: state hash`], rootStale: true };
  loaded.set(first.key, { record: first, world: root, state: rootState, ops: [] });
  for (const record of tree.moments.slice(1)) {
    const parent = record.parentKey === null ? undefined : loaded.get(record.parentKey);
    const input = record.input;
    if (parent === undefined || input === null) {
      stale.push(`${record.key}: its parent is stale`);
      continue;
    }
    if (momentKey(parent.record.key, input, record.lines) !== record.key) {
      stale.push(`${record.key}: key`);
      continue;
    }
    const draft = new Draft(parent.world, forbiddenInOp);
    for (const line of record.lines) draft.push(line, parseLine(line));
    if (draft.errors.length > 0) {
      stale.push(`${record.key}: lines no longer apply (${draft.errors[0] ?? ""})`);
      continue;
    }
    if (hashWorld(draft.world) !== record.stateHash) {
      stale.push(`${record.key}: state hash`);
      continue;
    }
    const prompt = projectEntity(
      draft.world,
      transition(record),
      parent.world,
      draft.ops,
      record.pictureLabels,
    ).prompt;
    if (prompt !== record.prompt) {
      stale.push(`${record.key}: prompt re-projects differently`);
      continue;
    }
    loaded.set(record.key, {
      record,
      world: draft.world,
      state: viewOf(draft.world),
      ops: draft.ops,
    });
  }
  return {
    moments: [...loaded.values()],
    stale,
    rootStale: false,
    behind: tree.hashes.instructions !== current.instructions,
    rebox: tree.hashes.jevModel !== current.jevModel,
  };
}
