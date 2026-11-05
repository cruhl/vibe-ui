import { phaseNames, type PhaseName } from "./phases.ts";

/** Typical seconds of each phase of a miss, used to pace the phase meter. */
export type PhaseSeconds = Record<PhaseName, number>;

/** Measured on real misses: about 1 s to the beat, 1.5 s to the queue, 4.5 s to build, 0.4 s to show. */
export const defaultPhaseSeconds: PhaseSeconds = {
  thinking: 1,
  writing: 1.5,
  filming: 4.5,
  arriving: 0.4,
};

/**
 * How long each phase of a finished miss took, for the pacing history: from when each phase began
 * to when the next one did, and the last to the first frame.
 */
export function phaseDurations(
  phaseStarts: Readonly<Record<PhaseName, number | null>>,
  firstFrameAt: number,
): Partial<PhaseSeconds> {
  const ends: Record<PhaseName, number | null> = {
    thinking: phaseStarts.writing,
    writing: phaseStarts.filming,
    filming: phaseStarts.arriving,
    arriving: firstFrameAt,
  };
  const durations: Partial<PhaseSeconds> = {};
  for (const name of phaseNames) {
    const start = phaseStarts[name];
    const end = ends[name];
    if (start !== null && end !== null && end >= start) durations[name] = end - start;
  }
  return durations;
}

/** The median of each phase over the samples, or the default where a phase has none. */
export function medianPhaseSeconds(samples: readonly Partial<PhaseSeconds>[]): PhaseSeconds {
  const median = (name: PhaseName) => {
    const values = samples
      .flatMap((sample) => (sample[name] === undefined ? [] : [sample[name]]))
      .sort((first, second) => first - second);
    return values.length === 0
      ? defaultPhaseSeconds[name]
      : (values[Math.floor(values.length / 2)] ?? defaultPhaseSeconds[name]);
  };
  return {
    thinking: median("thinking"),
    writing: median("writing"),
    filming: median("filming"),
    arriving: median("arriving"),
  };
}
