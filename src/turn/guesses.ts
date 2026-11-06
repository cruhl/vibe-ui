import type { MomentInput } from "../moments/index.ts";
import { record } from "../run-log/index.ts";
import { parseLine, type Draft, type World } from "../state/index.ts";
import { newDraft, usableDraft } from "./draft.ts";

/** The most follow-up clips one answer or guess chains after itself. */
export const followLimit = 2;

/**
 * One guess read from a line stream: its header, the draft its lines built, and the drafts of
 * the follow-ups chained after it, each built on the one before.
 */
export interface GuessBlock {
  index: number;
  guess: MomentInput;
  likelihood: number | null;
  draft: Draft;
  follows: Draft[];
}

/** Takes streamed lines; false means stop the stream here. */
export interface GuessTaker {
  take: (line: string) => boolean;
  end: () => void;
}

/** Whether a draft can be kept: no structural rejected line and a visible change. */
function keepable(draft: Draft): boolean {
  return !draft.errors.some((error) => /^[+-]/.test(error)) && usableDraft(draft);
}

/**
 * Reads `? id likelihood` guess blocks against a world: each header opens a guess, the lines under
 * it build that guess's draft, an `&` header under it opens a follow-up of that guess built on
 * its world, and the next header or the end hands the finished guess to `onGuess` while `alive`
 * holds. With `onFollow`, `&` blocks before the first guess are follow-ups of the moment the
 * guesses answer, each handed over as it closes, with whether another follows it; the guesses
 * are then read against the world after the last of them. A guess or follow-up with a structural
 * rejected line or no visible change is dropped and logged, and with it every follow-up after it;
 * follow-ups past `followLimit` are dropped. `take` returns false once a header past `limit`, or
 * for a thing already guessed, arrives: the caller stops the stream there.
 */
export function readGuesses(options: {
  world: World;
  limit: number;
  roundID: string;
  alive: () => boolean;
  onGuess: (block: GuessBlock) => void;
  onFollow?: (draft: Draft, continues: boolean) => void;
}): GuessTaker {
  const { limit, roundID } = options;
  let base = options.world;
  let block: GuessBlock | null = null;
  let follow: Draft | null = null;
  let leading = 0;
  let broken = false;
  let guessed = false;
  const seen = new Set<string>();
  const closeLeading = (continues: boolean) => {
    const current = follow;
    follow = null;
    if (current === null || broken || !options.alive()) return;
    if (!keepable(current)) {
      broken = true;
      record("follow_rejected", {
        roundID,
        guess: null,
        errors: current.errors,
        crowded: current.crowded,
        lines: current.lines,
      });
      return;
    }
    base = current.world;
    options.onFollow?.(current, continues);
  };
  const flush = () => {
    const current = block;
    block = null;
    if (current === null || !options.alive()) return;
    if (!keepable(current.draft)) {
      record("guess_rejected", {
        roundID,
        elementID: current.guess.elementID,
        errors: current.draft.errors,
        crowded: current.draft.crowded,
      });
      return;
    }
    if (current.draft.errors.length > 0)
      record("guess_lines_dropped", {
        roundID,
        elementID: current.guess.elementID,
        errors: current.draft.errors,
      });
    const kept = current.follows.findIndex((draft) => !keepable(draft));
    if (kept >= 0)
      record("follow_rejected", {
        roundID,
        guess: current.guess.elementID,
        errors: current.follows[kept]?.errors ?? [],
        crowded: current.follows[kept]?.crowded ?? [],
        lines: current.follows[kept]?.lines ?? [],
      });
    options.onGuess(kept < 0 ? current : { ...current, follows: current.follows.slice(0, kept) });
  };
  return {
    take: (line) => {
      const parsed = parseLine(line);
      if (parsed.ok && parsed.op.op === "follow") {
        const current = block;
        if (current !== null) {
          const last = current.follows.at(-1)?.world ?? current.draft.world;
          if (current.follows.length < followLimit) current.follows.push(newDraft(last));
          else broken = true;
          return true;
        }
        if (guessed || options.onFollow === undefined) {
          record("follow_orphaned", { roundID });
          return true;
        }
        leading++;
        closeLeading(leading <= followLimit);
        if (leading > followLimit) broken = true;
        if (!broken) follow = newDraft(base);
        return true;
      }
      if (parsed.ok && parsed.op.op === "guess") {
        closeLeading(false);
        flush();
        guessed = true;
        broken = false;
        if (seen.size >= limit || seen.has(parsed.op.elementID)) {
          record("guesses_capped", { roundID, at: parsed.op.elementID });
          return false;
        }
        seen.add(parsed.op.elementID);
        block = {
          index: seen.size - 1,
          guess: { elementID: parsed.op.elementID, action: "click", text: null },
          likelihood: parsed.op.likelihood,
          draft: newDraft(base),
          follows: [],
        };
        return true;
      }
      const current = block;
      if (current !== null) {
        if (current.follows.length === followLimit && broken) return true;
        (current.follows.at(-1) ?? current.draft).push(line, parsed);
      } else if (follow !== null) follow.push(line, parsed);
      else if (!broken) record("guess_line_orphaned", { roundID, line });
      return true;
    },
    end: () => {
      closeLeading(false);
      flush();
    },
  };
}
