import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { record } from "../run-log/index.ts";
import { shareScenario, writeStore } from "../scenario/index.ts";
import { keysURL } from "../route/index.ts";
import { Icon } from "./icon.tsx";

const exampleIdeas = [
  "a lighthouse keeper's last night before the storm",
  "a submarine diner where the fish order lunch",
  "a tiny city living inside a snow globe",
  "a museum where the paintings talk back",
];

/** A writer error in plain words: repeated "Error:" prefixes dropped, a rejected key named. */
function readableError(error: string): { text: string; keys: boolean } {
  const bare = error.replace(/^(\s*Error:\s*)+/i, "").trim();
  if (bare === "no keys") return { text: "The demo is off right now.", keys: true };
  if (/\b401\b|incorrect api key|invalid api key/i.test(bare))
    return { text: "That OpenAI key didn't work.", keys: true };
  if (/\b429\b/.test(bare))
    return {
      text: "Too many worlds at once. Try again in a minute.",
      keys: false,
    };
  return { text: `Couldn't make that world (${bare}).`, keys: false };
}

type ShareState = "idle" | "sharing" | "copied" | "failed";

/**
 * Sharing a written world: puts it in the shared store and copies its link, with the state of
 * the last try for the button's label.
 */
export function useShare(scenarioID: string): [ShareState, () => void] {
  const [state, setState] = useState<ShareState>("idle");
  const share = () => {
    setState("sharing");
    shareScenario(scenarioID)
      .then((link) => navigator.clipboard.writeText(link))
      .then(() => {
        setState("copied");
      })
      .catch((error: unknown) => {
        record("world_share_failed", { scenarioID, message: String(error) });
        setState("failed");
      });
  };
  return [state, share];
}

/** The label of a share button in each state. */
export const shareLabels: Record<ShareState, string> = {
  idle: "Copy link",
  sharing: "Copying",
  copied: "Link copied",
  failed: "Couldn't share",
};

/**
 * The front of the create flow, drawn as a blank screen waiting for a world: the idea is written
 * on it like a title card (Enter makes it), with a few ideas to start from and the writer's error
 * under the button when the last try failed. Submitting hands the idea to `onWrite`; the progress
 * takes over from there.
 */
export function CreateForm({
  onWrite,
  focus,
}: {
  onWrite: (idea: string) => void;
  focus: boolean;
}) {
  const [idea, setIdea] = useState("");
  const write = useStore(writeStore);
  const writing = write.stage !== null && write.launchedID === null;
  const input = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (focus) input.current?.focus();
  }, [focus]);
  const error = write.error === null || writing ? null : readableError(write.error);
  return (
    <section className="create" aria-labelledby="create-title" data-writing={writing}>
      <span className="create-static" aria-hidden="true" />
      <h2 id="create-title" className="create-title">
        Make your own world
      </h2>
      <p className="create-lede">Describe a world in one line, then play it and share it.</p>
      <form
        className="create-form"
        data-testid="scenario-write"
        onSubmit={(event) => {
          event.preventDefault();
          if (idea.trim() !== "") onWrite(idea);
        }}
      >
        <textarea
          ref={input}
          className="create-idea"
          data-testid="scenario-idea"
          rows={2}
          value={writing ? (write.idea ?? idea) : idea}
          disabled={writing}
          maxLength={280}
          placeholder="A house that moves at night"
          aria-label="Your world idea"
          enterKeyHint="go"
          spellCheck={false}
          onChange={(event) => {
            setIdea(event.target.value.replace(/\n/g, " "));
          }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }}
        />
        <button
          type="submit"
          className="button-primary create-make"
          disabled={writing || idea.trim() === ""}
        >
          {writing ? <span className="spinner" aria-hidden="true" /> : <Icon name="make" />}
          {writing ? "Writing" : "Make it"}
        </button>
        {error === null ? null : (
          <p className="create-error" data-testid="scenario-error" role="alert">
            {error.text} {error.keys ? <a href={keysURL()}>Set up your keys</a> : null}
          </p>
        )}
      </form>
      <div className="create-ideas" role="group" aria-labelledby="create-ideas-label">
        <span id="create-ideas-label" className="create-ideas-label">
          Or start from
        </span>
        {exampleIdeas.map((example) => (
          <button
            key={example}
            type="button"
            className="create-example"
            disabled={writing}
            onClick={() => {
              setIdea(example);
              input.current?.focus();
            }}
          >
            <span>{example}</span>
            <Icon name="send" />
          </button>
        ))}
      </div>
    </section>
  );
}

interface ProgressProps {
  /** The world on stage now. */
  scenarioID: string;
  /** Whether the world on stage has shown its opening's first frame. */
  framed: boolean;
  /** Whether the opening failed. */
  failed: boolean;
}

type StepState = "waiting" | "active" | "done";

/**
 * The create flow while a world is made: the idea, the world's name the moment it is written,
 * its premise as it streams in, and three steps (premise, world, filming the opening) that light
 * up in turn. It stays over the stage through the opening's filming and fades out on the first
 * frame, which brings up a line offering the world's link.
 */
export function CreateProgress({ scenarioID, framed, failed }: ProgressProps) {
  const write = useStore(writeStore);
  const launched = write.launchedID !== null && write.launchedID === scenarioID;
  const writing = write.stage !== null && write.launchedID === null;
  const filming = launched && !framed && !failed;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [shareState, share] = useShare(scenarioID);
  const live = launched && framed && dismissed !== scenarioID;
  if (!writing && !filming)
    return live ? (
      <div className="create-live" role="status" data-testid="create-live">
        <span className="create-live-text">
          <strong>{write.name ?? "Your world"}</strong> is live. Anyone with the link can play it.
        </span>
        <button
          type="button"
          className="button-primary create-live-share"
          disabled={shareState === "sharing"}
          onClick={share}
        >
          {shareLabels[shareState]}
        </button>
        <button
          type="button"
          className="create-live-dismiss"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(scenarioID);
          }}
        >
          Close
        </button>
      </div>
    ) : null;
  const premiseDone = write.stage !== "premise" || launched;
  const steps: { label: string; state: StepState }[] = [
    { label: "Writing the story", state: premiseDone ? "done" : "active" },
    { label: "Building the world", state: launched ? "done" : premiseDone ? "active" : "waiting" },
    { label: "Filming the first scene", state: launched ? "active" : "waiting" },
  ];
  return (
    <div
      className="create-progress"
      role="status"
      aria-live="polite"
      data-testid="scenario-progress"
      data-phase={filming ? "filming" : "writing"}
    >
      <div className="create-progress-glow" aria-hidden="true" />
      <div className="create-progress-body">
        <p className="create-progress-idea">“{write.idea ?? ""}”</p>
        <h1 className="create-progress-name" data-named={write.name !== null}>
          {write.name ?? "A new world"}
        </h1>
        <div className="create-progress-premise">
          <p>
            {write.premise.replace(/^#{1,6}\s+/gm, "").replace(/\n{2,}/g, "\n")}
            {write.stage === "premise" && !launched ? (
              <span className="create-caret" aria-hidden="true" />
            ) : null}
          </p>
        </div>
        <ol className="create-steps">
          {steps.map((step) => (
            <li key={step.label} className="create-step" data-state={step.state}>
              <span className="create-step-mark" aria-hidden="true" />
              {step.label}
            </li>
          ))}
        </ol>
        <p className="create-progress-count">
          {launched
            ? "First scene coming up."
            : write.characters === 0
              ? ""
              : `${write.characters.toLocaleString()} characters written`}
        </p>
      </div>
    </div>
  );
}
