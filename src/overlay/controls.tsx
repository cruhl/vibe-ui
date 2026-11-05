import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  currentRoute,
  endedURL,
  ideaURL,
  routeURL,
  scenarioURL,
  takeFromRoute,
} from "../route/index.ts";
import {
  currentScenarioID,
  findScenario,
  launchScenario,
  writeAndLaunch,
} from "../scenario/index.ts";
import { record } from "../run-log/index.ts";
import { setSoundMuted } from "../sound/index.ts";
import { Icon } from "./icon.tsx";
import { ScenarioPicker } from "./picker.tsx";
import { shareLabels, useShare } from "./create.tsx";
import { shutDownThen } from "./shutdown.ts";

interface Props {
  /** The name of the world on stage, for the always-visible world button. */
  worldName: string;
  muted: boolean;
  canEnd: boolean;
  /** Whether the world has shown its first frame; pause and messages wait for it. */
  framed: boolean;
  paused: boolean;
  /** Whether the session has ended. */
  ended: boolean;
  /** How many direct messages have been sent; the message box closes when one more is. */
  messagesSent: number;
  messageBox?: ReactNode;
  onToggleMute: () => void;
  onPause: () => void;
  onResume: () => void;
  /** Ends the session; resolves once every session it opened has closed. */
  onEnd: () => Promise<void>;
}

const revealMs = 2600;
const armMs = 4000;

let hideTimer: ReturnType<typeof setTimeout> | null = null;

function useRevealed(pinned: boolean): [boolean, () => void] {
  const [visible, setVisible] = useState(false);
  const reveal = useCallback(() => {
    setVisible(true);
    if (hideTimer !== null) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      setVisible(false);
    }, revealMs);
  }, []);
  useEffect(() => {
    window.addEventListener("pointermove", reveal);
    return () => {
      window.removeEventListener("pointermove", reveal);
      if (hideTimer !== null) clearTimeout(hideTimer);
    };
  }, [reveal]);
  return [pinned || visible, reveal];
}

function typing(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * The session controls, the same for every scenario: play or pause, restart (ends every session and
 * starts the same scenario fresh), end (shuts down to the picker), the direct message box, the
 * picker, and mute. Hidden in clean mode until the pointer moves or a key is pressed: Space plays
 * and pauses, Escape shows the controls. The picker is also the home screen when the URL names no
 * scenario, and it opens by itself when the run ends.
 */
export function Controls({
  worldName,
  muted,
  canEnd,
  framed,
  paused,
  ended,
  messagesSent: sentCount,
  messageBox = null,
  onToggleMute,
  onPause,
  onResume,
  onEnd,
}: Props) {
  const [composing, setComposing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => {
      setArmed(false);
    }, armMs);
    return () => {
      clearTimeout(timer);
    };
  }, [armed]);
  const leave = (url: string) => {
    setLeaving(true);
    shutDownThen(onEnd, canEnd, url);
  };
  const [home] = useState(() => currentRoute().home);
  const [picking, setPicking] = useState(home);
  const [focusCreate, setFocusCreate] = useState(false);
  const scenarioID = currentScenarioID();
  const written = findScenario(scenarioID)?.origin === "written";
  const [shareState, share] = useShare(scenarioID);
  const openPicker = (create: boolean) => {
    setFocusCreate(create);
    setPicking(true);
  };
  const [endedWorld] = useState(() => (home ? takeFromRoute("ended") : null));
  const [shown, reveal] = useRevealed(composing || paused);
  const [sentWhenOpened, setSentWhenOpened] = useState(sentCount);
  if (composing && sentCount > sentWhenOpened) {
    setComposing(false);
    setSentWhenOpened(sentCount);
  }
  const toggleMute = useRef(onToggleMute);
  const togglePause = useRef(paused ? onResume : onPause);
  useEffect(() => {
    toggleMute.current = onToggleMute;
    togglePause.current = paused ? onResume : onPause;
  });
  useEffect(() => {
    if (home && canEnd) void onEnd();
  }, [home, canEnd, onEnd]);
  useEffect(() => {
    const idea = home ? takeFromRoute("idea") : null;
    if (idea !== null) void writeAndLaunch(idea);
  }, [home]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (typing(event.target)) return;
      if (event.key === "Escape") reveal();
      if (event.key === " " && canEnd) {
        event.preventDefault();
        reveal();
        togglePause.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  });
  useEffect(() => {
    if (!muted) return;
    const unmute = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(".controls") !== null) return;
      record("unmuted_on_gesture", { gesture: event.type });
      setSoundMuted(false);
      toggleMute.current();
    };
    if (navigator.userActivation.hasBeenActive && !home) {
      const timer = setTimeout(() => {
        record("unmuted_on_gesture", { gesture: "earlier" });
        toggleMute.current();
      }, 0);
      return () => {
        clearTimeout(timer);
      };
    }
    window.addEventListener("pointerdown", unmute, { capture: true, once: true });
    window.addEventListener("keydown", unmute, { capture: true, once: true });
    return () => {
      window.removeEventListener("pointerdown", unmute, { capture: true });
      window.removeEventListener("keydown", unmute, { capture: true });
    };
  }, [muted, home]);
  return (
    <>
      <div className="controls" data-shown={shown} data-testid="session-controls">
        <div className="controls-bar">
          <button
            type="button"
            className="control control-wide control-pause"
            aria-label={paused ? "Play" : "Pause"}
            title={paused ? "Play (Space)" : "Pause (Space)"}
            disabled={!canEnd || !framed}
            onClick={() => {
              togglePause.current();
            }}
          >
            <Icon name={paused ? "play" : "pause"} />
            <span>{paused ? "Play" : "Pause"}</span>
          </button>
          <button
            type="button"
            className="control control-wide"
            aria-label="Restart"
            title="Start this world over"
            disabled={!canEnd}
            onClick={() => {
              leave(routeURL());
            }}
          >
            <Icon name="restart" />
            <span>Restart</span>
          </button>
          <span className="control-gap" />
          {messageBox === null ? null : (
            <button
              type="button"
              className="control control-wide"
              aria-label="Type a message"
              title="Tell the world what to do"
              aria-pressed={composing}
              disabled={!framed}
              onClick={() => {
                setSentWhenOpened(sentCount);
                setComposing(!composing);
              }}
            >
              <Icon name="message" />
              <span>Message</span>
            </button>
          )}
          <button
            type="button"
            className="control control-wide"
            aria-label="Choose another world"
            title="Choose another world"
            onClick={() => {
              openPicker(false);
            }}
          >
            <Icon name="worlds" />
            <span>Worlds</span>
          </button>
          {written ? (
            <button
              type="button"
              className="control control-wide"
              aria-label="Copy a link to this world"
              title="Anyone with the link can play this world"
              disabled={shareState === "sharing"}
              onClick={share}
            >
              <Icon name="link" />
              <span>{shareState === "idle" ? "Share" : shareLabels[shareState]}</span>
            </button>
          ) : null}
          <button
            type="button"
            className="control control-wide"
            aria-label={muted ? "Unmute" : "Mute"}
            title={muted ? "Sound off" : "Sound on"}
            onClick={() => {
              setSoundMuted(!muted);
              onToggleMute();
            }}
          >
            <Icon name={muted ? "muted" : "sound"} />
            <span>{muted ? "Unmute" : "Mute"}</span>
          </button>
          <span className="control-gap" />
          <button
            type="button"
            className="control control-wide control-end"
            aria-label={armed ? "Confirm end" : "Shut down"}
            title={armed ? "Press again to end" : "End this world"}
            data-armed={armed}
            disabled={!canEnd}
            onClick={() => {
              if (!armed) {
                setArmed(true);
                return;
              }
              leave(endedURL(currentScenarioID()));
            }}
          >
            <Icon name="end" />
            <span>{armed ? "End now?" : "End"}</span>
          </button>
        </div>
        {composing && messageBox !== null ? (
          <div className="message-slot" data-testid="message-slot">
            {messageBox}
          </div>
        ) : null}
      </div>
      {picking || (ended && !leaving) ? null : (
        <nav className="world-chips" aria-label="Worlds">
          <button
            type="button"
            className="world-chip"
            data-testid="world-chip"
            title="Choose another world"
            onClick={() => {
              openPicker(false);
            }}
          >
            <Icon name="worlds" />
            <span className="world-chip-name">{worldName}</span>
          </button>
          <button
            type="button"
            className="world-chip"
            data-testid="make-chip"
            title="Make your own world from a one-line idea"
            onClick={() => {
              openPicker(true);
            }}
          >
            <Icon name="make" />
            <span>Make your own</span>
          </button>
        </nav>
      )}
      {leaving ? (
        <div className="leaving" role="status">
          <span className="spinner" aria-hidden="true" />
          Closing the world
        </div>
      ) : null}
      {picking || (ended && !leaving) ? (
        <ScenarioPicker
          heading={ended && !home ? "Pick another world" : "Choose a world"}
          currentScenarioID={home ? endedWorld : currentScenarioID()}
          endedScenarioID={home ? endedWorld : null}
          canShutDown={canEnd && !home}
          focusCreate={focusCreate}
          onChoose={(scenarioID) => {
            if (home && launchScenario(scenarioID)) return;
            leave(scenarioURL(scenarioID));
          }}
          onWrite={(idea) => {
            if (home) void writeAndLaunch(idea);
            else shutDownThen(onEnd, canEnd, ideaURL(idea));
          }}
          onShutDown={() => {
            leave(endedURL(currentScenarioID()));
          }}
          onClose={
            home || ended
              ? null
              : () => {
                  setPicking(false);
                }
          }
        />
      ) : null}
    </>
  );
}
