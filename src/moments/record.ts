import { hashWorld } from "../state/index.ts";
import type { BakedMoment } from "./manifest.ts";
import type { Moment } from "./moment.ts";

/** The fields a new moment is written with; everything else starts empty. */
export type MomentFields = Pick<
  Moment,
  | "key"
  | "parentKey"
  | "input"
  | "index"
  | "label"
  | "lines"
  | "ops"
  | "world"
  | "state"
  | "beat"
  | "likelihood"
  | "memory"
  | "prompt"
  | "pictureLabels"
>;

/**
 * A moment in its first status, written, with nothing filmed, captured or boxed yet. What it
 * introduces and removes is measured against its parent, when it has one.
 */
export function newMoment(fields: MomentFields, parent: Moment | null): Moment {
  const before = parent?.state.elements ?? [];
  const beforeIDs = new Set(before.map((element) => element.id));
  return {
    ...fields,
    status: "written",
    start: null,
    clipID: null,
    slot: null,
    clipURL: null,
    clip: null,
    held: null,
    boxes: null,
    checks: null,
    children: "none",
    baked: false,
    introduced: fields.state.elements
      .filter((element) => !beforeIDs.has(element.id))
      .map((element) => element.id),
    removed: before.filter(
      (element) => !fields.state.elements.some((kept) => kept.id === element.id),
    ),
    abort: new AbortController(),
    refilms: 0,
  };
}

/**
 * A moment as a baked tree holds it: filmed (with its media names, boxes and checks) when its
 * clip size is given and it is ready, else written only.
 */
export function momentRecord(moment: Moment, clipBytes: number | null): BakedMoment {
  const ready = clipBytes !== null && moment.status === "ready" && moment.held !== null;
  return {
    key: moment.key,
    parentKey: moment.parentKey,
    input: moment.input,
    index: moment.index,
    label: moment.label,
    lines: moment.lines,
    beat: moment.beat,
    likelihood: moment.likelihood,
    memory: moment.memory,
    stateHash: hashWorld(moment.world),
    prompt: moment.prompt,
    pictureLabels: moment.pictureLabels,
    start: moment.start,
    status: ready ? "ready" : "written",
    boxes: ready ? moment.boxes : null,
    checks: ready ? moment.checks : null,
    clip: ready ? `${moment.key}.mp4` : null,
    held: ready ? `${moment.key}.jpg` : null,
    clipBytes: ready ? clipBytes : null,
    heldBytes: ready ? (moment.held?.size ?? null) : null,
  };
}
