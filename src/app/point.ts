import type { AgentInput } from "../agent/index.ts";
import { boxAround, type Point } from "../boxes/index.ts";
import { captureFrame, captureRegion } from "../frame/index.ts";
import { jevDeadline, pointAt, type JevConnection, type PointCandidate } from "../jev/index.ts";
import { record, withDeadline } from "../run-log/index.ts";
import type { TypingTarget } from "../overlay/index.ts";
import { walk, type View, type World } from "../state/index.ts";
import { logPointJev } from "./jev-log.ts";

/** How wide a share of the frame the crop around a point covers; it is square on the frame. */
const cropShare = 0.25;
/** Pixels across the crop is drawn at; Jev refuses images much under 300 pixels. */
const cropPixels = 448;
/** How sure Jev must be that a spot is a field made for typed words for the click to open typing there. */
const fieldPresence = 0.5;

/** What a point click hands Jev, taken from the video at the click: the whole frame and the crop. */
export interface PointPictures {
  frame: string;
  crop: string;
}

/** The agent's input for a click on no box. */
export type PointInput = Extract<AgentInput, { kind: "point" }>;

const hundredths = (value: number) => Math.round(value * 100) / 100;

/** Every thing in the world as Jev weighs it for a point, in paint order. */
export function pointCandidates(world: World): PointCandidate[] {
  return walk(world).map((entity) => ({ id: entity.id, look: entity.look, state: entity.state }));
}

/**
 * The agent's input for a click on no box: a click at that point on the thing Jev saw there,
 * labelled by its look, or on open background when Jev saw none or named a thing no longer there.
 */
export function pointInput(point: Point, thingID: string | null, world: World): PointInput {
  const thing = thingID === null ? undefined : world.entities[thingID];
  return {
    kind: "point",
    x: hundredths(point.x),
    y: hundredths(point.y),
    thingID: thing?.id ?? null,
    label: thing?.look ?? "open background",
  };
}

/**
 * What a click on no box does: a click on an input Jev saw there, or on a spot Jev saw as a field
 * made for typed words, opens typing there and is never an action; any other click is the agent's
 * input for that spot.
 */
export type PointOutcome =
  { kind: "typing"; target: TypingTarget } | { kind: "point"; input: PointInput };

/** The outcome of a click on no box, from the thing Jev saw there and how sure it is of a field. */
export function pointOutcome(
  point: Point,
  seen: { thingID: string | null; field: number },
  view: View,
): PointOutcome {
  const input = pointInput(point, seen.thingID, view.world);
  const typed = view.elements.find(
    (element) => element.id === input.thingID && element.kind === "input",
  );
  if (typed !== undefined)
    return {
      kind: "typing",
      target: { elementID: typed.id, thingID: typed.id, label: typed.label, ...point },
    };
  if (seen.field >= fieldPresence)
    return {
      kind: "typing",
      target: { elementID: null, thingID: input.thingID, label: input.label, ...point },
    };
  return { kind: "point", input };
}

/** The frame on the video now and a square crop of it centered on the point, or null before one paints. */
export function capturePoint(video: HTMLVideoElement, point: Point): PointPictures | null {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;
  const box = boxAround(point, cropShare, (cropShare * video.videoWidth) / video.videoHeight);
  const frame = captureFrame(video);
  const crop = captureRegion(video, box, cropPixels);
  return frame === null || crop === null ? null : { frame: frame.base64, crop: crop.base64 };
}

/**
 * Asks Jev what is at a point within its deadline and returns what the click does, logged as
 * `point_seen` with the crop; null, logged as `point_failed`, when Jev does not answer.
 */
export async function seePoint(
  connection: JevConnection,
  pictures: PointPictures,
  point: Point,
  view: View,
  inputID: string,
): Promise<PointOutcome | null> {
  const started = performance.now();
  try {
    const result = await withDeadline("jev_point", jevDeadline, (signal) =>
      pointAt(connection, pictures.frame, pictures.crop, pointCandidates(view.world), signal),
    );
    logPointJev(inputID, point, pictures.crop, result, Math.round(performance.now() - started));
    return pointOutcome(point, result, view);
  } catch (error: unknown) {
    record("point_failed", { inputID, ...point, message: String(error) });
    return null;
  }
}
