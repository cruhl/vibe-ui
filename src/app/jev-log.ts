import { captureFile } from "../capture/index.ts";
import type { BoxResult } from "../jev/index.ts";
import { record } from "../run-log/index.ts";

function decodeJPEG(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: "image/jpeg" });
}

let sequence = 0;

/** Logs one answered Jev request: `boxes_ready`, then the frame it saw and its whole exchange. */
export function logJev(
  source: "capture" | "playing" | "held",
  fields: { key?: string; clipID: string | null },
  frameBase64: string,
  result: BoxResult,
  latencyMs: number,
): void {
  record("boxes_ready", {
    source,
    ...fields,
    latencyMs,
    inputTokens: result.inputTokens,
    model: result.model,
    boxes: result.boxes,
    likelihoods: result.likelihoods,
    degradation: result.degradation,
  });
  sequence++;
  const frame = `jev/${String(sequence).padStart(5, "0")}.jpg`;
  captureFile(frame, decodeJPEG(frameBase64));
  record("jev_exchange", {
    frame,
    source,
    clipID: fields.clipID,
    questions: result.questions,
    answers: result.answers,
  });
}

/** How a guess is put to Jev for ranking. */
export function guessQuestion(guess: {
  input: { action: "click" | "type"; text: string | null } | null;
  label: string;
}): string {
  return guess.input?.action === "type"
    ? `type ${guess.input.text ?? ""} into ${guess.label}`
    : `choose ${guess.label}`;
}
