import type { ChildrenStatus, MomentStatus } from "./moment.ts";

/** One moment as the scheduler sees it. */
export interface NodeView {
  key: string;
  parentKey: string | null;
  depth: number;
  probability: number;
  index: number;
  status: MomentStatus;
  children: ChildrenStatus;
  /** Times its film was refused or rejected. */
  refilms: number;
}

/** What a moment's children can start from: its built clip on a session, its held frame. */
export interface SourceView {
  key: string;
  /** The session that built its clip while that clip is still among its last built, else null. */
  retainedOn: number | null;
  /** Whether its held frame is local, so a child can be pinned on it anywhere. */
  held: boolean;
}

/** One session of the pool as the scheduler sees it. */
export interface SessionView {
  index: number;
  ready: boolean;
  /** Builds sent and not yet generated: the running one and any waiting. */
  outstanding: number;
  /** Kept free of the tree so a miss never waits behind a guess. */
  reserved: boolean;
}

export interface Limits {
  /** Moments this many steps below the moment on stage or fewer are filmed. */
  filmDepth: number;
  /** Moments this many steps below the moment on stage or fewer are written. */
  writeDepth: number;
  /** The running build plus waiting builds allowed on one session. */
  perSession: number;
}

export interface FilmOrder {
  key: string;
  slot: number;
  start: "latent" | "pinned";
}

export interface Plan {
  /** Moments whose own guesses to ask for now, most likely first. */
  write: string[];
  /** Moments to film now, each on its session, most likely first. */
  film: FilmOrder[];
}

/** Most likely first; ties go to the shallower moment, then the agent's order. */
function priority(first: NodeView, second: NodeView): number {
  return (
    second.probability - first.probability ||
    first.depth - second.depth ||
    first.index - second.index
  );
}

/**
 * The work to start now, from the tree and the pool; pure, so the same views always give the same
 * plan. A moment's own guesses are asked for once it is close enough to the moment on stage. A written
 * moment close enough is filmed: the likeliest child of a moment whose clip is still retained on
 * its builder continues it there, queued right behind it; every other child is pinned on its
 * parent's held frame on the least loaded unreserved session. No session takes more than its
 * budget, and a moment refilmed once is never filmed again ahead of need.
 */
export function schedule(
  nodes: readonly NodeView[],
  sources: readonly SourceView[],
  sessions: readonly SessionView[],
  limits: Limits,
): Plan {
  const ordered = [...nodes].sort(priority);
  const write = ordered
    .filter((node) => node.children === "none" && node.depth < limits.writeDepth)
    .map((node) => node.key);
  const sourceOf = new Map(sources.map((source) => [source.key, source]));
  const load = new Map(sessions.map((session) => [session.index, session.outstanding]));
  const open = (index: number) => {
    const session = sessions.find((item) => item.index === index);
    return (
      session !== undefined &&
      session.ready &&
      !session.reserved &&
      (load.get(index) ?? 0) < limits.perSession
    );
  };
  const latentTaken = new Set<string>();
  const bestChild = new Map<string, string>();
  for (const node of ordered)
    if (node.parentKey !== null && !bestChild.has(node.parentKey))
      bestChild.set(node.parentKey, node.key);
  for (const node of ordered)
    if (node.parentKey !== null && node.status !== "written" && node.status !== "rejected")
      latentTaken.add(node.parentKey);
  const film: FilmOrder[] = [];
  for (const node of ordered) {
    if (node.status !== "written" || node.depth < 1 || node.depth > limits.filmDepth) continue;
    if (node.refilms > 0 || node.parentKey === null) continue;
    const source = sourceOf.get(node.parentKey);
    if (source === undefined) continue;
    const retained = source.retainedOn;
    if (
      retained !== null &&
      bestChild.get(node.parentKey) === node.key &&
      !latentTaken.has(node.parentKey) &&
      open(retained)
    ) {
      latentTaken.add(node.parentKey);
      load.set(retained, (load.get(retained) ?? 0) + 1);
      film.push({ key: node.key, slot: retained, start: "latent" });
      continue;
    }
    if (!source.held) continue;
    const idlest = sessions
      .filter((session) => open(session.index))
      .sort(
        (first, second) =>
          (load.get(first.index) ?? 0) - (load.get(second.index) ?? 0) ||
          first.index - second.index,
      )[0];
    if (idlest === undefined) continue;
    load.set(idlest.index, (load.get(idlest.index) ?? 0) + 1);
    film.push({ key: node.key, slot: idlest.index, start: "pinned" });
  }
  return { write, film };
}

/**
 * The session kept for misses: the ready session other than the one holding the stage's clip
 * with the fewest builds outstanding, the highest index on a tie; null with fewer than two ready.
 */
export function reserveSession(
  sessions: readonly Omit<SessionView, "reserved">[],
  stageSlot: number | null,
): number | null {
  const ready = sessions.filter((session) => session.ready);
  if (ready.length < 2) return null;
  const others = ready.filter((session) => session.index !== stageSlot);
  return (
    [...others].sort(
      (first, second) => first.outstanding - second.outstanding || second.index - first.index,
    )[0]?.index ?? null
  );
}
