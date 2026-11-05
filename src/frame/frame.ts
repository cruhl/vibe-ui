import type { Box } from "../jev/index.ts";

/** A still from the playing video, as JPEG base64 for Jev and a data URL for debugging. */
export interface Frame {
  base64: string;
  width: number;
  height: number;
  luma: number;
}

const scratch = new Map<string, HTMLCanvasElement>();

/** One reusable canvas per use, made the first time that use needs it, never at import. */
function scratchCanvas(use: string, width = 0, height = 0): HTMLCanvasElement {
  const existing = scratch.get(use);
  if (existing !== undefined) return existing;
  const created = document.createElement("canvas");
  created.width = width;
  created.height = height;
  scratch.set(use, created);
  return created;
}

/**
 * Draws the current video frame to a canvas no wider than `maxWidth` and encodes it. Returns null
 * before the first frame arrives.
 */
export function captureFrame(video: HTMLVideoElement, maxWidth = 1024): Frame | null {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;
  const canvas = scratchCanvas("frame");
  const scale = Math.min(1, maxWidth / video.videoWidth);
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return null;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const dataURL = canvas.toDataURL("image/jpeg", 0.85);
  return {
    base64: dataURL.slice(dataURL.indexOf(",") + 1),
    width: canvas.width,
    height: canvas.height,
    luma: measureLuma(context, canvas.width, canvas.height),
  };
}

function measureLuma(context: CanvasRenderingContext2D, width: number, height: number): number {
  const pixels = context.getImageData(0, 0, width, height).data;
  let total = 0;
  let count = 0;
  for (let i = 0; i < pixels.length; i += 4 * 97) {
    total += 0.299 * (pixels[i] ?? 0) + 0.587 * (pixels[i + 1] ?? 0) + 0.114 * (pixels[i + 2] ?? 0);
    count++;
  }
  return count === 0 ? 0 : total / count;
}

/** The current video frame as a JPEG data URL no wider than `maxWidth`, or null before one paints. */
export function frameDataURL(video: HTMLVideoElement, maxWidth: number): string | null {
  const frame = captureFrame(video, maxWidth);
  return frame === null ? null : `data:image/jpeg;base64,${frame.base64}`;
}

/** A box of the current video frame (fractions of the frame) on a canvas of its own pixels. */
export function cropVideo(video: HTMLVideoElement, box: Box): HTMLCanvasElement | null {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;
  const left = Math.max(0, box.left) * video.videoWidth;
  const top = Math.max(0, box.top) * video.videoHeight;
  const width = Math.max(1, (Math.min(1, box.right) - Math.max(0, box.left)) * video.videoWidth);
  const height = Math.max(1, (Math.min(1, box.bottom) - Math.max(0, box.top)) * video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width);
  canvas.height = Math.round(height);
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.drawImage(video, left, top, width, height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Cuts a box (fractions of the frame) out of a picture, with a small margin, as a JPEG. */
export async function cropStill(image: Blob, box: Box): Promise<Blob | null> {
  const bitmap = await createImageBitmap(image);
  const margin = 0.08;
  const left = Math.max(0, box.left - (box.right - box.left) * margin) * bitmap.width;
  const right = Math.min(1, box.right + (box.right - box.left) * margin) * bitmap.width;
  const top = Math.max(0, box.top - (box.bottom - box.top) * margin) * bitmap.height;
  const bottom = Math.min(1, box.bottom + (box.bottom - box.top) * margin) * bitmap.height;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(right - left));
  canvas.height = Math.max(1, Math.round(bottom - top));
  const context = canvas.getContext("2d");
  if (context === null) return null;
  context.drawImage(
    bitmap,
    left,
    top,
    right - left,
    bottom - top,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  bitmap.close();
  return new Promise((resolve) => {
    canvas.toBlob(resolve, "image/jpeg", 0.92);
  });
}

/** A 32 by 18 grey thumbnail used to tell one frame from the next, and its mean brightness. */
export function thumbnail(
  video: HTMLVideoElement,
): { pixels: Uint8ClampedArray; luma: number } | null {
  if (video.videoWidth === 0) return null;
  const probe = scratchCanvas("thumbnail", 32, 18);
  const context = probe.getContext("2d", { willReadFrequently: true });
  if (context === null) return null;
  context.drawImage(video, 0, 0, probe.width, probe.height);
  const data = context.getImageData(0, 0, probe.width, probe.height).data;
  const pixels = new Uint8ClampedArray(probe.width * probe.height);
  let total = 0;
  for (let i = 0; i < pixels.length; i++) {
    const value =
      0.299 * (data[i * 4] ?? 0) + 0.587 * (data[i * 4 + 1] ?? 0) + 0.114 * (data[i * 4 + 2] ?? 0);
    pixels[i] = value;
    total += value;
  }
  return { pixels, luma: total / pixels.length };
}

/** Mean absolute difference between two thumbnails, 0 to 255. */
export function difference(first: Uint8ClampedArray, second: Uint8ClampedArray): number {
  let total = 0;
  for (let i = 0; i < first.length; i++) total += Math.abs((first[i] ?? 0) - (second[i] ?? 0));
  return first.length === 0 ? 0 : total / first.length;
}

/** The current video frame at full size as a JPEG blob, for a pinned first frame or an asset. */
export async function captureStill(video: HTMLVideoElement): Promise<Blob | null> {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;
  const still = scratchCanvas("still");
  still.width = video.videoWidth;
  still.height = video.videoHeight;
  const context = still.getContext("2d");
  if (context === null) return null;
  context.drawImage(video, 0, 0);
  return new Promise((resolve) => {
    still.toBlob(resolve, "image/jpeg", 0.92);
  });
}

async function encode(bitmap: ImageBitmap, width: number, height: number, quality: number) {
  const encoder = scratchCanvas("encoder");
  encoder.width = width;
  encoder.height = height;
  const context = encoder.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("no canvas to encode a still");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => {
    encoder.toBlob(resolve, "image/jpeg", quality);
  });
  if (blob === null) throw new Error("the still did not encode");
  return { blob, context };
}

/** Any picture (a PNG last frame, a baked still) as a native-size JPEG held frame. */
export async function heldStill(image: Blob, quality = 0.85): Promise<Blob> {
  const bitmap = await createImageBitmap(image);
  try {
    return (await encode(bitmap, bitmap.width, bitmap.height, quality)).blob;
  } finally {
    bitmap.close();
  }
}

/**
 * A held frame as Jev reads it, the same as `captureFrame` makes from the video on screen: JPEG
 * base64 no wider than `maxWidth`, with its brightness.
 */
export async function frameOfStill(still: Blob, maxWidth = 1024): Promise<Frame> {
  const bitmap = await createImageBitmap(still);
  try {
    const scale = Math.min(1, maxWidth / bitmap.width);
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);
    const { blob, context } = await encode(bitmap, width, height, 0.85);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return { base64: btoa(binary), width, height, luma: measureLuma(context, width, height) };
  } finally {
    bitmap.close();
  }
}

/**
 * The same 32 by 18 grey thumbnail as `thumbnail`, downscaled in two smoothed steps so a decoded
 * still and a video frame of the same picture compare closely (a straight downscale aliases).
 */
export function smoothThumbnail(source: HTMLVideoElement | ImageBitmap): Uint8ClampedArray {
  const smoothHalf = scratchCanvas("smooth-half", 168, 96);
  const smoothProbe = scratchCanvas("smooth-probe", 32, 18);
  const half = smoothHalf.getContext("2d");
  const small = smoothProbe.getContext("2d", { willReadFrequently: true });
  if (half === null || small === null) throw new Error("no canvas for a thumbnail");
  half.imageSmoothingQuality = "high";
  half.drawImage(source, 0, 0, smoothHalf.width, smoothHalf.height);
  small.imageSmoothingQuality = "high";
  small.drawImage(smoothHalf, 0, 0, smoothProbe.width, smoothProbe.height);
  const data = small.getImageData(0, 0, smoothProbe.width, smoothProbe.height).data;
  const pixels = new Uint8ClampedArray(smoothProbe.width * smoothProbe.height);
  for (let i = 0; i < pixels.length; i++)
    pixels[i] =
      0.299 * (data[i * 4] ?? 0) + 0.587 * (data[i * 4 + 1] ?? 0) + 0.114 * (data[i * 4 + 2] ?? 0);
  return pixels;
}

/**
 * How far a clip's first frame is from a still, as the mean thumbnail difference (0 to 255): the
 * seam a viewer sees when the clip starts on that still. Decodes only the first frame, off stage.
 */
export async function seamFromStill(clip: string, still: Blob): Promise<number> {
  const bitmap = await createImageBitmap(still);
  const video = document.createElement("video");
  try {
    const stillPixels = smoothThumbnail(bitmap);
    video.muted = true;
    video.preload = "auto";
    const loaded = new Promise<void>((resolve, reject) => {
      video.addEventListener(
        "loadeddata",
        () => {
          resolve();
        },
        { once: true },
      );
      video.addEventListener(
        "error",
        () => {
          reject(new Error("the clip did not decode"));
        },
        { once: true },
      );
    });
    video.src = clip;
    await loaded;
    return difference(smoothThumbnail(video), stillPixels);
  } finally {
    bitmap.close();
    video.removeAttribute("src");
    video.load();
  }
}
