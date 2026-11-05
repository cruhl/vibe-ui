import { useEffect, useState } from "react";
import { routeURL, scenarioURL } from "../route/index.ts";
import { shutDownThen } from "./shutdown.ts";

interface NoticeInput {
  inputID: string;
  failed: string | null;
  firstFrameAt: number | null;
}

interface Props {
  inputs: readonly NoticeInput[];
  running: boolean;
  /** Whether the stage takes input now. */
  accepting: boolean;
  /** Whether the picture is holding still, waiting on the person. */
  held: boolean;
  paused: boolean;
  worldName: string;
  /** Makes a failed input once more, by its id. */
  onRetry: (inputID: string) => void;
  /** Ends the session; resolves once every session it opened has closed. */
  onEnd: () => Promise<void>;
}

const hintDelayMs = 600;

const slowFailures = new Set(["build_stall", "play_stall", "first_frame_stall", "lock_deadline"]);
const agentFailures = new Set(["agent_failed", "projection_failed"]);

/**
 * What a failed input's failure name (the controller's `<name>: <detail>`) means to the person: a
 * refusal will fail the same way again, so it offers no retry; anything else (a stall, a missed
 * deadline, a failed agent turn, a lost clip) is worth one more try.
 */
function failureCopy(failed: string): { text: string; retry: boolean } {
  const name = failed.split(":")[0] ?? "";
  if (name === "enqueue_refused")
    return { text: "Can't film that one. Try something else.", retry: false };
  if (slowFailures.has(name)) return { text: "That took too long.", retry: true };
  if (agentFailures.has(name)) return { text: "The world got stuck on that one.", retry: true };
  return { text: "That scene didn't come through.", retry: true };
}
const idleHintMs = 6000;

/**
 * The stage's plain-language voice, the same for every world: a first-time hint that the picture
 * is clickable, shown from the first frame until the first input and again when a held frame has
 * waited a while on the person; a note when an input's answer
 * fails, kept until it is dismissed or the next input; and, when the opening itself fails, a card
 * that says so and offers a retry or another world, so the stage is never silently empty.
 */
export function Notice({
  inputs,
  running,
  accepting,
  held,
  paused,
  worldName,
  onRetry: retryInput,
  onEnd,
}: Props) {
  const onRetry = () => {
    shutDownThen(onEnd, running, routeURL());
  };
  const onChoose = () => {
    shutDownThen(onEnd, running, scenarioURL(null));
  };
  const opening = inputs[0];
  const last = inputs.at(-1);
  const openingFailed =
    opening !== undefined && opening.failed !== null && opening.firstFrameAt === null;
  const lastFailed =
    !openingFailed &&
    last !== undefined &&
    inputs.length > 1 &&
    last.failed !== null &&
    last.firstFrameAt === null
      ? last.inputID
      : null;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [hintFor, setHintFor] = useState<string | null>(null);
  const answeredID = last !== undefined && last.firstFrameAt !== null ? last.inputID : null;
  const waitingForFirst = running && accepting && !paused && inputs.length === 1;
  const idle = running && accepting && held && !paused && inputs.length > 1;
  const hintKey = waitingForFirst || idle ? answeredID : null;
  useEffect(() => {
    if (hintKey === null) return;
    const timer = setTimeout(
      () => {
        setHintFor(hintKey);
      },
      waitingForFirst ? hintDelayMs : idleHintMs,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [hintKey, waitingForFirst]);
  if (openingFailed)
    return (
      <div className="notice notice-card" role="alert" data-testid="notice-opening">
        <p className="notice-title">{worldName} didn't open</p>
        <p className="notice-body">The first scene didn't come through.</p>
        <div className="notice-actions">
          <button type="button" className="button-primary" onClick={onRetry} autoFocus>
            Try again
          </button>
          <button type="button" onClick={onChoose}>
            Choose another world
          </button>
        </div>
      </div>
    );
  const failure = last?.failed == null ? null : failureCopy(last.failed);
  if (lastFailed !== null && dismissed !== lastFailed && failure !== null)
    return (
      <div className="notice notice-toast" role="status" data-testid="notice-failed">
        <span>{failure.text}</span>
        {failure.retry ? (
          <button
            type="button"
            className="notice-dismiss button-primary"
            onClick={() => {
              setDismissed(lastFailed);
              retryInput(lastFailed);
            }}
          >
            Try again
          </button>
        ) : null}
        <button
          type="button"
          className="notice-dismiss"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(lastFailed);
          }}
        >
          OK
        </button>
      </div>
    );
  if (hintKey !== null && hintFor === hintKey)
    return (
      <div className="notice notice-hint" data-testid="notice-hint" aria-live="polite">
        <span className="notice-hint-pointer">Click anything you see</span>
        <span className="notice-hint-touch">Tap anything you see</span>
      </div>
    );
  return null;
}
