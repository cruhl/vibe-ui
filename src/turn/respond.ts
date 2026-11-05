import type { AgentInput } from "../agent/index.ts";
import { describeChange } from "../projector/index.ts";
import { record } from "../run-log/index.ts";
import { parseLine, type Draft, type World } from "../state/index.ts";
import { draftProblems, newDraft, usableDraft } from "./draft.ts";
import type { GuessTaker } from "./guesses.ts";

/** How a committed answer came about, for the log. */
export interface TurnStats {
  readyMs: number;
  rejected: number;
  reasked: boolean;
}

/** What answering one input needs from its owner. */
export interface RespondOptions {
  inputID: string;
  world: World;
  /** Re-ask on any rejected line (`errors`) or only when the change is unusable (`unusable`). */
  reask: "errors" | "unusable";
  /** How long the re-ask may take before the first usable answer is kept, or the turn fails. */
  reaskMs: number;
  /** Aborts the whole turn. */
  signal: AbortSignal;
  /** Streams one agent attempt that lists `problems`; null when it cannot be asked at all. */
  stream: (
    problems: readonly string[],
    signal: AbortSignal,
    onLine: (line: string) => void,
  ) => Promise<void> | null;
  /** The change so far, once a line applies. */
  onProgress: (beat: string | null) => void;
  /** The change is settled: films it, and returns where the guesses that follow go, or null. */
  onCommit: (draft: Draft, stats: TurnStats) => GuessTaker | null;
  /** The stream has ended after a commit: every guess is in. */
  onWritten: () => void;
  /** The turn failed with no usable change. */
  onFail: (detail: string) => void;
}

/**
 * Answers an input in the line format. Each line applies to a draft of the world as it closes; the
 * first guess header, or the end of the stream, settles the change and commits it while guesses
 * keep streaming to the taker the commit returns. Rejected lines are dropped; a turn left with no
 * usable change (or, with `errors`, any rejected line) is asked again once with its problems
 * listed, under its own short deadline, and the second answer is used, or the first when only it
 * was usable.
 */
export function respond(input: AgentInput, options: RespondOptions): void {
  const { inputID, world, signal } = options;
  const started = performance.now();
  let guesses: GuessTaker | null = null;
  let rejected = 0;
  let reasked = false;
  let committed = false;
  let earlier: Draft | null = null;
  const commit = (draft: Draft) => {
    committed = true;
    guesses = options.onCommit(draft, {
      readyMs: Math.round(performance.now() - started),
      rejected,
      reasked,
    });
  };
  const attempt = (problems: readonly string[]) => {
    const attemptAbort = new AbortController();
    const onOuterAbort = () => {
      attemptAbort.abort();
    };
    signal.addEventListener("abort", onOuterAbort);
    const draft = newDraft(world);
    let capped = false;
    const reaskTimer =
      problems.length === 0
        ? null
        : setTimeout(() => {
            if (committed || attemptAbort.signal.aborted || signal.aborted) return;
            record("deadline_missed", { call: "agent_reask", milliseconds: options.reaskMs });
            attemptAbort.abort();
            if (earlier !== null) {
              record("reask_unusable", { inputID, kept: "first answer" });
              commit(earlier);
              return;
            }
            options.onFail(`the re-ask missed its ${options.reaskMs} ms deadline`);
          }, options.reaskMs);
    const settle = (): boolean => {
      const usable = usableDraft(draft);
      const reask = options.reask === "errors" ? draft.errors.length > 0 || !usable : !usable;
      if (reask && !reasked) {
        reasked = true;
        earlier = usable ? draft : null;
        const found = draftProblems(draft);
        record("state_rejected", { inputID, problems: found });
        attemptAbort.abort();
        attempt(found);
        return false;
      }
      if (!usable && earlier !== null) {
        record("reask_unusable", { inputID, kept: "first answer" });
        commit(earlier);
        return true;
      }
      if (!usable) {
        record("turn_valid", { inputID, projector: "entity", valid: false });
        attemptAbort.abort();
        options.onFail("no usable change after a re-ask");
        return false;
      }
      commit(draft);
      return true;
    };
    const take = (line: string) => {
      if (guesses === null || guesses.take(line)) return;
      capped = true;
      attemptAbort.abort();
    };
    const onLine = (line: string) => {
      if (attemptAbort.signal.aborted) return;
      if (committed) {
        take(line);
        return;
      }
      const parsed = parseLine(line);
      if (parsed.ok && parsed.op.op === "guess") {
        if (settle()) take(line);
        return;
      }
      const error = draft.push(line, parsed);
      if (error === null) {
        options.onProgress(describeChange(world, draft.world, draft.ops));
        return;
      }
      rejected++;
      record("line_rejected", { inputID, line, error });
    };
    const streaming = options.stream(problems, attemptAbort.signal, onLine);
    if (streaming === null) return;
    streaming
      .then(() => {
        if (attemptAbort.signal.aborted) return;
        if (!committed && !settle()) return;
        guesses?.end();
        options.onWritten();
      })
      .catch((error: unknown) => {
        if (signal.aborted) return;
        if (committed) {
          if (!capped) record("candidates_cut", { inputID, reason: String(error) });
          guesses?.end();
          options.onWritten();
          return;
        }
        if (attemptAbort.signal.aborted && reasked) return;
        record("turn_valid", { inputID, projector: "entity", valid: false });
        options.onFail(String(error));
      })
      .finally(() => {
        if (reaskTimer !== null) clearTimeout(reaskTimer);
        signal.removeEventListener("abort", onOuterAbort);
      });
  };
  attempt([]);
}
