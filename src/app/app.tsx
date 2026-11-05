import { useCallback, useEffect, useMemo, useState } from "react";
import { useStore } from "zustand";
import { currentKeys, KeysScreen, useCurrentKeys } from "../keys/index.ts";
import { MomentPlayer, OmniPlayer } from "../omni/index.ts";
import { DebugPanel, useDebugMode } from "../debug/index.ts";
import { InstructBox } from "../instruct/index.ts";
import { acknowledge, LivenessLayer, nudgeBusy, type StageHandle } from "../liveness/index.ts";
import { Controls, CreateProgress, Notice, Overlay, PoweredBy } from "../overlay/index.ts";
import { currentRoute, replaceRoute } from "../route/index.ts";
import type { Controller } from "./controller.ts";

const swapFallbackMs = 1200;

const underlapMs = 400;

/**
 * The slot whose picture is on screen, and the one it replaced: the shown slot follows the active
 * slot only once a first frame has landed after the switch (or a short fallback), and the replaced
 * slot stays painted underneath a little longer, so a swap never reveals a slot that has not yet
 * composited its first frame.
 */
function useShownSlot(active: number, frames: number): { shown: number; under: number | null } {
  const [shown, setShown] = useState<{ slot: number; under: number | null }>({
    slot: active,
    under: null,
  });
  const [switchedAt, setSwitchedAt] = useState({ slot: active, frames });
  if (switchedAt.slot !== active) setSwitchedAt({ slot: active, frames });
  const painted = switchedAt.slot === active && frames > switchedAt.frames;
  if (painted && shown.slot !== active) setShown({ slot: active, under: shown.slot });
  useEffect(() => {
    if (shown.slot === active) return;
    const timer = setTimeout(() => {
      setShown({ slot: active, under: shown.slot });
    }, swapFallbackMs);
    return () => {
      clearTimeout(timer);
    };
  }, [active, shown.slot]);
  useEffect(() => {
    if (shown.under === null) return;
    const timer = setTimeout(() => {
      setShown((current) => ({ slot: current.slot, under: null }));
    }, underlapMs);
    return () => {
      clearTimeout(timer);
    };
  }, [shown.under]);
  return { shown: shown.slot, under: shown.under };
}

function Stage({ controller }: { controller: Controller }) {
  const state = useStore(controller.store);
  const [muted, setMuted] = useState(true);
  const debug = useDebugMode();
  const last = state.inputs.at(-1);
  const running = state.phase === "running";
  const unanswered = last !== undefined && last.firstFrameAt === null && last.failed === null;
  const connecting = running && (last === undefined || (state.inputs.length === 1 && unanswered));
  const pending = running && unanswered && !connecting;
  const streams = controller.streams();
  const shownSlot = useShownSlot(state.activeSlot, state.firstFrames);
  const [stageElement, setStageElement] = useState<HTMLDivElement | null>(null);
  const stage = useMemo<StageHandle | null>(
    () => (stageElement === null ? null : { element: stageElement, video: () => controller.video }),
    [stageElement, controller],
  );
  const end = useCallback(() => controller.end("end_button"), [controller]);
  return (
    <div className="stage-page" data-debug={debug}>
      <div
        className="stage"
        ref={setStageElement}
        data-session-status={state.sessionStatus}
        data-busy={state.busy}
      >
        {streams.map((stream, index) => (
          <OmniPlayer
            key={index}
            stream={stream}
            trackCount={state.slots[index]?.trackCount ?? 0}
            active={index === state.activeSlot}
            visible={index === shownSlot.shown}
            under={index === shownSlot.under}
            muted={muted}
            onVideo={(video) => {
              controller.attachVideo(index, video);
            }}
          />
        ))}
        {([0, 1] as const).map((player) => (
          <MomentPlayer
            key={`moment-${String(player)}`}
            active={state.localPlayer === player}
            muted={muted}
            onVideo={(video) => {
              controller.attachLocal(player, video);
            }}
          />
        ))}
        <Overlay
          elements={state.shownView.elements}
          boxes={state.boxes}
          enabled={running}
          locked={state.locked !== null}
          debug={debug}
          onClick={(element) => {
            controller.input({ kind: "click", elementID: element.id });
          }}
          onPoint={(x, y) => {
            controller.input({ kind: "click", x, y });
          }}
          onType={(element, text) => {
            controller.input({ kind: "type", elementID: element.id, text });
          }}
          onPress={(press) => {
            if (stage !== null) acknowledge(stage, { ...press, inputID: null, source: "pointer" });
          }}
          onRefused={nudgeBusy}
        />
        {debug ? null : (
          <Notice
            inputs={state.inputs}
            running={running}
            accepting={state.locked === null}
            held={state.heldReady}
            paused={state.paused}
            worldName={state.scenario.name}
            onRetry={(inputID) => {
              controller.retry(inputID);
            }}
            onEnd={end}
          />
        )}
      </div>
      <LivenessLayer
        store={controller.store}
        stage={stage}
        pending={pending}
        connecting={connecting}
      />
      <Controls
        worldName={state.scenario.name}
        muted={muted}
        canEnd={running}
        framed={state.inputs[0]?.firstFrameAt != null}
        paused={state.paused}
        ended={state.phase === "ended"}
        messagesSent={state.inputs.filter((input) => input.kind === "instruct").length}
        messageBox={
          <InstructBox
            enabled={running}
            onSend={(text) => {
              controller.input({ kind: "instruct", text });
            }}
          />
        }
        onToggleMute={() => {
          setMuted(!muted);
        }}
        onPause={() => {
          controller.pause();
        }}
        onResume={() => {
          controller.resume();
        }}
        onEnd={end}
      />
      <CreateProgress
        scenarioID={state.scenario.id}
        framed={state.inputs[0]?.firstFrameAt != null}
        failed={state.inputs[0]?.failed != null}
      />
      {debug ? <DebugPanel state={state} /> : null}
    </div>
  );
}

/**
 * The app. It runs on the visitor's own keys when this browser has them, else on hosted play:
 * the front door opens a world straight away, and `?preset=` opens that one. The keys screen
 * shows only when asked (`?keys`, the "use your own keys" link) or when a world is chosen with no
 * way to run it (hosted play off and no keys saved). The Powered by Reactor badge is over every
 * screen.
 */
export function App({ controller }: { controller: Controller }) {
  const phase = useStore(controller.store, (state) => state.phase);
  const keys = useCurrentKeys();
  const [route] = useState(currentRoute);
  const [keysAsked, setKeysAsked] = useState(route.keys);
  useEffect(() => {
    if (!route.autostart) return;
    const ready = currentKeys();
    if (ready !== null) controller.start(ready);
  }, [controller, route]);
  const needKeys = phase === "keys" && keys === null && route.scenario !== null;
  return (
    <>
      {keysAsked || needKeys ? (
        <KeysScreen
          onStart={(saved) => {
            if (keysAsked) {
              replaceRoute({ keys: null });
              setKeysAsked(false);
            }
            if (route.scenario !== null && controller.store.getState().phase === "keys")
              controller.start(saved);
          }}
          onClose={
            keysAsked
              ? () => {
                  replaceRoute({ keys: null });
                  setKeysAsked(false);
                  const ready = currentKeys();
                  if (route.scenario !== null && ready !== null && phase === "keys")
                    controller.start(ready);
                }
              : null
          }
        />
      ) : (
        <Stage controller={controller} />
      )}
      <PoweredBy />
    </>
  );
}
