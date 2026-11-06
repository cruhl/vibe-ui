import type { BoxResult, ElementBox } from "../jev/index.ts";

/** A thing is found on a held frame at this presence or more. */
export const readyPresence = 0.5;
/** A held frame passes only when more than this share of the things in view have a found box. */
const boxableShare = 0.5;
/** A removed thing still this present lingers, so the frame did not take it away. */
const lingeringPresence = 0.8;
/** A degradation score of this or worse rejects the frame. */
const readyDegradation = 2;
/**
 * The largest seam a latent moment may start with before it is refilmed pinned, measured with the
 * brightness offset taken out so a continuation's exposure shift is not read as a cut. Pinned moments
 * have their seam recorded but never fail on it: a pin is exact unless the prompt itself cuts
 * away, which a refilm would repeat.
 */
const seamLimit = 13;

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

const hundredths = (value: number) => Math.round(value * 100) / 100;

/**
 * What a held frame should show: the thing chosen to reach it (null for an opening or a
 * follow-up), the things its state added and the things it took away.
 */
export interface Expected {
  chosen: string | null;
  introduced: readonly string[];
  removed: readonly { id: string }[];
}

/** How a held frame measured against what it should show, and whether it passes. */
export interface HeldVerdict {
  presence: number;
  introducedPresence: number | null;
  subjectPresence: number | null;
  boxable: number | null;
  lingering: number | null;
  passed: boolean;
}

/**
 * The things an answer is about: the chosen thing while it stays in view, else what the answer
 * brought into view, as when the chosen thing became something else or led to a new place.
 */
export function subjectOf(expected: Expected, inView: readonly string[]): string[] {
  const chosen = expected.chosen;
  return chosen !== null && inView.includes(chosen) ? [chosen] : [...expected.introduced];
}

/**
 * Checks a held frame: `inView` is every thing its state has in view, `boxes` the hittable boxes
 * on it, `found` every presence Jev reported, and `degradation` its last degradation score. It
 * passes when the answer's subject is there, most things in view have a found box, what it
 * removes is gone, and the picture is not degraded.
 */
export function heldVerdict(
  expected: Expected,
  inView: readonly string[],
  boxes: readonly ElementBox[],
  found: readonly ElementBox[],
  degradation: number | null,
): HeldVerdict {
  const presences = new Map(found.map((item) => [item.elementID, item.presence]));
  const presenceOf = (id: string) => presences.get(id) ?? 0;
  const subject = subjectOf(expected, inView);
  const boxed = new Set(
    boxes.filter((box) => box.presence >= readyPresence).map((box) => box.elementID),
  );
  const presence = mean(boxes.map((box) => box.presence));
  const introducedPresence =
    expected.introduced.length === 0 ? null : mean(expected.introduced.map(presenceOf));
  const subjectPresence = subject.length === 0 ? null : mean(subject.map(presenceOf));
  const boxable =
    inView.length === 0 ? null : inView.filter((id) => boxed.has(id)).length / inView.length;
  const lingering =
    expected.removed.length === 0
      ? null
      : mean(expected.removed.map((element) => presenceOf(element.id)));
  return {
    presence,
    introducedPresence,
    subjectPresence,
    boxable,
    lingering,
    passed:
      (subjectPresence === null || subjectPresence >= readyPresence) &&
      (boxable === null || boxable > boxableShare) &&
      (lingering === null || lingering < lingeringPresence) &&
      (degradation ?? 0) < readyDegradation,
  };
}

/** Whether a removed thing's presence still lingers on the frame. */
export const lingers = (lingering: number) => lingering >= lingeringPresence;

/**
 * The held-frame checks of a captured moment from Jev's answer on its own held frame, rounded for
 * keeping: the held verdict, plus its seam, which fails a latent start past the seam limit.
 */
export function momentChecks(
  expected: Expected & { start: "latent" | "pinned" | "fresh" | null },
  inView: readonly string[],
  boxes: readonly ElementBox[],
  result: BoxResult,
  seam: number | null,
) {
  const round = (value: number | null) => (value === null ? null : hundredths(value));
  const degradation = round(result.degradation);
  const verdict = heldVerdict(expected, inView, boxes, result.boxes, degradation);
  return {
    presence: hundredths(verdict.presence),
    introducedPresence: round(verdict.introducedPresence),
    subjectPresence: round(verdict.subjectPresence),
    boxable: round(verdict.boxable),
    lingering: round(verdict.lingering),
    degradation,
    seam: seam === null ? null : Math.round(seam * 10) / 10,
    passed: verdict.passed && (seam === null || expected.start !== "latent" || seam <= seamLimit),
  };
}
