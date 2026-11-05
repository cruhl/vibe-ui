import { z } from "zod";
import { medianPhaseSeconds, type PhaseSeconds } from "./pacing.ts";

const storageKey = "vibe-ui.phase-seconds";
const keep = 24;
const Sample = z.object({
  thinking: z.number().optional(),
  writing: z.number().optional(),
  filming: z.number().optional(),
  arriving: z.number().optional(),
});

function read(): z.infer<typeof Sample>[] {
  const raw = localStorage.getItem(storageKey);
  if (raw === null) return [];
  try {
    const parsed = z.array(Sample).safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Adds the phase durations of one finished miss to this browser's pacing history. */
export function rememberPhases(sample: Partial<PhaseSeconds>): void {
  if (Object.keys(sample).length === 0) return;
  localStorage.setItem(storageKey, JSON.stringify([...read(), sample].slice(-keep)));
}

/** Typical phase seconds from the misses this browser has measured, defaults where none. */
export function measuredPhaseSeconds(): PhaseSeconds {
  return medianPhaseSeconds(read());
}
