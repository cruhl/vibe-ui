import { frameDataURL } from "../frame/index.ts";
import { currentScenarioID, subscribeScenarios } from "../scenario/index.ts";
import { preloadSounds, setBed, unlockOnGesture } from "../sound/index.ts";
import { put } from "../storage/index.ts";
import { acknowledgeInput, releaseAcknowledgements } from "./acknowledge.ts";
import { getBusyKit } from "./busy.ts";
import type { LivenessInput, LivenessState, LivenessStore, StageHandle } from "./feed.ts";
import { rememberPhases } from "./history.ts";
import { phaseDurations } from "./pacing.ts";
import type { PhaseName } from "./phases.ts";

const openingStillWidth = 480;

/** Where the picker finds a scenario's opening still: the first held frame of its last session. */
export function openingStillKey(scenarioID: string): string {
  return `opening-still/${scenarioID}`;
}

/**
 * Starts the liveness of one session, driven by its store: acknowledges every input a driver made
 * with a box, keeps the ambient sound bed playing between clips, stores the opening still for the
 * picker, and records each finished miss's phase timings for pacing. The held frame stays on
 * screen until the answer's own first frame replaces it. Returns the stopper.
 */
export function startLiveness(store: LivenessStore, stage: StageHandle): () => void {
  let currentMiss: string | null = null;
  let openingStored = false;
  let bedOn = false;
  const phaseStarts = new Map<PhaseName, number>();
  const stageFrame = (maxWidth: number) => {
    const video = stage.video();
    return video === null ? null : frameDataURL(video, maxWidth);
  };

  const land = (input: LivenessInput) => {
    if (input.outcome === "miss" && input.firstFrameAt !== null)
      rememberPhases(
        phaseDurations(
          {
            thinking: phaseStarts.get("thinking") ?? input.t,
            writing: phaseStarts.get("writing") ?? null,
            filming: phaseStarts.get("filming") ?? null,
            arriving: phaseStarts.get("arriving") ?? null,
          },
          input.firstFrameAt,
        ),
      );
  };

  const bed = (on: boolean) => {
    bedOn = on;
    const loaded = getBusyKit();
    setBed(
      on && loaded?.bedURL != null
        ? { url: loaded.bedURL, volume: loaded.kit.sounds.bed.volume }
        : null,
    );
  };

  const began = (input: LivenessInput) => {
    const previous = currentMiss === null ? undefined : find(store.getState(), currentMiss);
    currentMiss = input.outcome === "miss" ? input.inputID : null;
    if (previous !== undefined) land(previous);
    phaseStarts.clear();
    if (input.box !== null) {
      const box = input.box;
      queueMicrotask(() => {
        acknowledgeInput(stage, input.inputID, box.elementID, box.box, input.t);
      });
    }
  };

  const changed = (state: LivenessState, previous: LivenessState) => {
    if (state.phase === "ended" && previous.phase !== "ended") {
      releaseAcknowledgements();
      currentMiss = null;
      bed(false);
      return;
    }
    if (state.inputs !== previous.inputs) {
      for (const input of state.inputs.slice(previous.inputs.length))
        if (input.kind !== "start") began(input);
      for (const input of state.inputs) {
        const before = find(previous, input.inputID);
        if (input.failed !== null && before?.failed === null) releaseAcknowledgements();
        if (input.firstFrameAt !== null && before?.firstFrameAt === null) {
          releaseAcknowledgements();
          if (currentMiss === input.inputID) {
            currentMiss = null;
            land(input);
          }
        }
      }
    }
    const progress = state.progress;
    if (progress !== null && progress !== previous.progress && progress.inputID === currentMiss) {
      if (!phaseStarts.has(progress.phase)) phaseStarts.set(progress.phase, progress.since);
    }
    if (state.playing !== previous.playing) {
      bed(!state.playing);
      if (!state.playing && !openingStored) {
        openingStored = true;
        const still = stageFrame(openingStillWidth);
        if (still !== null) void put("frames", openingStillKey(currentScenarioID()), still);
      }
    }
  };

  const preload = () => {
    const loaded = getBusyKit();
    if (loaded !== null)
      preloadSounds([loaded.clickURL, loaded.bedURL].filter((url) => url !== null));
    if (bedOn) bed(true);
  };
  preload();
  const stopScenarios = subscribeScenarios(preload);
  const stopListening = store.subscribe(changed);
  const stopUnlock = unlockOnGesture();
  return () => {
    stopListening();
    stopScenarios();
    stopUnlock();
    bed(false);
  };
}

function find(state: LivenessState, inputID: string): LivenessInput | undefined {
  return state.inputs.find((input) => input.inputID === inputID);
}
