import { z } from "zod";
import type { BusyKit } from "./busy.ts";

/** The fal models a scenario's busy art comes from, shared by the browser and `pnpm busy-art`. */
export const artModels = {
  paint: "fal-ai/z-image/turbo",
  cutout: "fal-ai/birefnet",
  sound: "fal-ai/elevenlabs/sound-effects/v2",
} as const;

/** Deadlines in milliseconds for each fal call, from measured times plus generous headroom. */
export const artDeadlines = {
  paint: 15_000,
  cutout: 20_000,
  sound: 40_000,
  download: 20_000,
} as const;

export const ImageResult = z.object({ images: z.array(z.object({ url: z.string() })).min(1) });
export const CutoutResult = z.object({ image: z.object({ url: z.string() }) });
export const AudioResult = z.object({ audio: z.object({ url: z.string() }) });

/** fal's z-image request. */
export interface PaintRequest {
  prompt: string;
  image_size: { width: number; height: number };
  num_images: number;
  sync_mode?: boolean;
}

/** fal's birefnet request. */
export interface CutoutRequest {
  image_url: string;
  sync_mode?: boolean;
}

/** fal's ElevenLabs sound effects request. */
export interface SoundRequest {
  text: string;
  duration_seconds: number;
  prompt_influence: number;
  loop?: boolean;
}

/** The request that paints the indicator before it is cut out. */
export function paintRequest(kit: BusyKit, inline: boolean): PaintRequest {
  return {
    prompt: kit.indicator.prompt,
    image_size: { width: 512, height: 512 },
    num_images: 1,
    ...(inline ? { sync_mode: true } : {}),
  };
}

/** The request that cuts the painted indicator out of its white background. */
export function cutoutRequest(imageURL: string, inline: boolean): CutoutRequest {
  return { image_url: imageURL, ...(inline ? { sync_mode: true } : {}) };
}

/** The request that records the click or the looping ambient bed. */
export function soundRequest(kit: BusyKit, which: "click" | "bed"): SoundRequest {
  const sound = kit.sounds[which];
  return {
    text: sound.prompt,
    duration_seconds: Math.min(22, Math.max(0.5, sound.seconds)),
    prompt_influence: 0.6,
    ...(which === "bed" ? { loop: true } : {}),
  };
}
