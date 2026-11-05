import type { MomentInput } from "../moments/index.ts";
import { record } from "../run-log/index.ts";
import { parseLine, type Draft, type World } from "../state/index.ts";
import { newDraft, usableDraft } from "./draft.ts";

/** One guess read from a line stream: its header and the draft its lines built. */
export interface GuessBlock {
  index: number;
  guess: MomentInput;
  likelihood: number | null;
  draft: Draft;
}

/** Takes streamed lines; false means stop the stream here. */
export interface GuessTaker {
  take: (line: string) => boolean;
  end: () => void;
}

/**
 * Reads `? id likelihood` guess blocks against a world: each header opens a guess, the lines under
 * it build that guess's draft, and the next header or the end hands the finished guess to
 * `onGuess` while `alive` holds. A guess with a structural rejected line or no visible change is
 * dropped and logged. `take` returns false once a header past `limit`, or for a thing already
 * guessed, arrives: the caller stops the stream there.
 */
export function readGuesses(options: {
  world: World;
  limit: number;
  roundID: string;
  alive: () => boolean;
  onGuess: (block: GuessBlock) => void;
}): GuessTaker {
  const { world, limit, roundID } = options;
  let block: GuessBlock | null = null;
  const seen = new Set<string>();
  const flush = () => {
    const current = block;
    block = null;
    if (current === null || !options.alive()) return;
    const draft = current.draft;
    const structural = draft.errors.some((error) => /^[+-]/.test(error));
    if (structural || !usableDraft(draft)) {
      record("guess_rejected", {
        roundID,
        elementID: current.guess.elementID,
        errors: draft.errors,
      });
      return;
    }
    if (draft.errors.length > 0)
      record("guess_lines_dropped", {
        roundID,
        elementID: current.guess.elementID,
        errors: draft.errors,
      });
    options.onGuess(current);
  };
  return {
    take: (line) => {
      const parsed = parseLine(line);
      if (parsed.ok && parsed.op.op === "guess") {
        flush();
        if (seen.size >= limit || seen.has(parsed.op.elementID)) {
          record("guesses_capped", { roundID, at: parsed.op.elementID });
          return false;
        }
        seen.add(parsed.op.elementID);
        block = {
          index: seen.size - 1,
          guess: { elementID: parsed.op.elementID, action: "click", text: null },
          likelihood: parsed.op.likelihood,
          draft: newDraft(world),
        };
        return true;
      }
      const current = block;
      if (current === null) record("guess_line_orphaned", { roundID, line });
      else current.draft.push(line, parsed);
      return true;
    },
    end: flush,
  };
}
