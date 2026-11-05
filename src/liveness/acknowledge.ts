import { cropVideo } from "../frame/index.ts";
import type { Box } from "../jev/index.ts";
import { now, record } from "../run-log/index.ts";
import { playOnce } from "../sound/index.ts";
import { getBusyKit } from "./busy.ts";
import type { StageHandle } from "./feed.ts";
import { reducedMotion } from "./motion.ts";

/** One click to acknowledge: which element, where it is, and when the click arrived. */
export interface AcknowledgeRequest {
  elementID: string;
  box: Box;
  /** Session seconds when the click arrived. */
  clickT: number;
  inputID: string | null;
  source: "pointer" | "input";
}

interface Shown {
  elementID: string;
  clickT: number;
  inputID: string | null;
  paintedT: number | null;
}

const linkSeconds = 2;
const unlinkedMs = 900;
let last: Shown | null = null;
const held = new Set<HTMLElement>();

/**
 * Lets go of every acknowledgement still held on screen: called when the response's first frame
 * lands, the input fails, or the run ends. Until then the pressed element stays visibly pressed.
 */
export function releaseAcknowledgements(): void {
  for (const layer of held) {
    layer.dataset.released = "true";
    setTimeout(() => {
      layer.remove();
    }, 220);
  }
  held.clear();
}

function pressCrop(layer: HTMLElement, box: Box, video: HTMLVideoElement | null): void {
  const canvas = video === null ? null : cropVideo(video, box);
  if (canvas === null) return;
  canvas.className = "ack-pixels";
  layer.appendChild(canvas);
}

/**
 * Makes the clicked element react on the video itself within a frame: its own pixels, cut out of
 * the frame at its Jev box, are pressed, brightened or wobbled as the scenario's kit says, and the
 * kit's click sound plays. `acknowledged` is logged once the reaction has painted, with the
 * milliseconds from the click.
 */
export function acknowledge(stage: StageHandle, request: AcknowledgeRequest): void {
  const loaded = getBusyKit();
  const style = reducedMotion() ? "brighten" : (loaded?.kit.acknowledge ?? "press");
  const layer = document.createElement("div");
  layer.className = `ack ack-${style}`;
  layer.dataset.testid = "acknowledge";
  layer.dataset.elementId = request.elementID;
  layer.style.left = `${request.box.left * 100}%`;
  layer.style.top = `${request.box.top * 100}%`;
  layer.style.width = `${(request.box.right - request.box.left) * 100}%`;
  layer.style.height = `${(request.box.bottom - request.box.top) * 100}%`;
  if (loaded !== null) layer.style.setProperty("--ack-glow", loaded.kit.colors.glow);
  pressCrop(layer, request.box, stage.video());
  releaseAcknowledgements();
  stage.element.appendChild(layer);
  held.add(layer);
  if (loaded?.clickURL != null) playOnce(loaded.clickURL, loaded.kit.sounds.click.volume);
  const shown: Shown = {
    elementID: request.elementID,
    clickT: request.clickT,
    inputID: request.inputID,
    paintedT: null,
  };
  last = shown;
  if (request.inputID === null)
    setTimeout(() => {
      if (shown.inputID === null && held.has(layer)) {
        held.delete(layer);
        layer.remove();
      }
    }, unlinkedMs);
  requestAnimationFrame(() => {
    setTimeout(() => {
      const paintedT = now();
      shown.paintedT = paintedT;
      record("acknowledged", {
        inputID: shown.inputID,
        elementID: shown.elementID,
        source: request.source,
        style,
        clickT: shown.clickT,
        paintedT,
        ms: Math.round((paintedT - shown.clickT) * 1000),
      });
    }, 0);
  });
}

/**
 * Called for every `input` the controller logs. A click the pointer already acknowledged is linked
 * to its input id; any other input with a box (a driver, the eval user, typed text) is
 * acknowledged now.
 */
export function acknowledgeInput(
  stage: StageHandle,
  inputID: string,
  elementID: string,
  box: Box,
  t: number,
): void {
  const recent = last;
  if (
    recent !== null &&
    recent.inputID === null &&
    recent.elementID === elementID &&
    t - recent.clickT <= linkSeconds
  ) {
    recent.inputID = inputID;
    if (recent.paintedT !== null)
      record("acknowledge_linked", {
        inputID,
        elementID,
        clickT: recent.clickT,
        paintedT: recent.paintedT,
        ms: Math.round((recent.paintedT - recent.clickT) * 1000),
      });
    return;
  }
  acknowledge(stage, { elementID, box, clickT: t, inputID, source: "input" });
}
