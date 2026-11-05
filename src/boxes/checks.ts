import type { BoxResult, ElementBox } from "../jev/index.ts";

/** A held frame shows what it should when its things average at least this presence. */
export const readyPresence = 0.5;
/** A removed thing still this present lingers, so the frame did not take it away. */
const lingeringPresence = 0.8;
/** A degradation score of this or worse rejects the frame. */
const readyDegradation = 2;
/**
 * The largest seam a latent moment may start with before it is refilmed pinned. Pinned moments
 * have their seam recorded but never fail on it: a pin is exact unless the prompt itself cuts
 * away, which a refilm would repeat.
 */
const seamLimit = 13;

const mean = (values: readonly number[]) =>
  values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;

const hundredths = (value: number) => Math.round(value * 100) / 100;

/** What a held frame must show: the things its state added and the things it took away. */
export interface Expected {
  introduced: readonly string[];
  removed: readonly { id: string }[];
}

/** How a held frame measured against what it should show, and whether it passes. */
export interface HeldVerdict {
  presence: number;
  introducedPresence: number | null;
  lingering: number | null;
  passed: boolean;
}

/**
 * Checks a held frame: `boxes` are the hittable boxes on it, `found` every presence Jev reported,
 * and `degradation` its last degradation score. It passes when enough of what it shows is found,
 * what it adds is there, what it removes is gone, and the picture is not degraded.
 */
export function heldVerdict(
  expected: Expected,
  boxes: readonly ElementBox[],
  found: readonly ElementBox[],
  degradation: number | null,
): HeldVerdict {
  const presences = new Map(found.map((item) => [item.elementID, item.presence]));
  const presence = mean(boxes.map((box) => box.presence));
  const introducedPresence =
    expected.introduced.length === 0
      ? null
      : mean(expected.introduced.map((id) => presences.get(id) ?? 0));
  const lingering =
    expected.removed.length === 0
      ? null
      : mean(expected.removed.map((element) => presences.get(element.id) ?? 0));
  return {
    presence,
    introducedPresence,
    lingering,
    passed:
      presence >= readyPresence &&
      (introducedPresence === null || introducedPresence >= readyPresence) &&
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
  boxes: readonly ElementBox[],
  result: BoxResult,
  seam: number | null,
) {
  const round = (value: number | null) => (value === null ? null : hundredths(value));
  const degradation = round(result.degradation);
  const verdict = heldVerdict(expected, boxes, result.boxes, degradation);
  return {
    presence: hundredths(verdict.presence),
    introducedPresence: round(verdict.introducedPresence),
    lingering: round(verdict.lingering),
    degradation,
    seam: seam === null ? null : Math.round(seam * 10) / 10,
    passed: verdict.passed && (seam === null || expected.start !== "latent" || seam <= seamLimit),
  };
}
