import { frameSize } from "../omni/index.ts";

/** Options for the ambient glow cast by the picture around the stage and onto the page. */
export interface GlowOptions {
  /** The video to sample, read on every sample so a slot switch is followed. */
  source: () => HTMLVideoElement | null;
  /** The element the blurred halo sits behind; it gets the halo layer as its first child. */
  host: HTMLElement;
  /** Called with each new glow color, for the page light. */
  onColor: (color: string) => void;
  sampleWidth?: number;
  sampleHeight?: number;
  intervalMs?: number;
  crossfadeMs?: number;
  blur?: number;
  overhang?: number;
  strength?: number;
}

/** A running glow. */
export interface Glow {
  start: () => void;
  stop: () => void;
  sample: () => void;
  setWaiting: (waiting: boolean) => void;
  destroy: () => void;
}

const restOpacity = 0.5;
const waitingOpacity = 1;

/**
 * Every two seconds draws the current frame into a 16 by 10 canvas, averages it, pulls the average
 * toward a vivid version of its own hue, and cross-fades a heavily blurred copy of the tiny frame
 * behind the stage over 2.5 s; the color also tints the page. Brighter and a little more saturated
 * while the stage is waiting on an answer.
 */
export function createGlow({
  source,
  host,
  onColor,
  sampleWidth = 16,
  sampleHeight = 10,
  intervalMs = 2000,
  crossfadeMs = 2500,
  blur = 150,
  overhang = 0.15,
  strength = 0.5,
}: GlowOptions): Glow {
  const layer = document.createElement("div");
  layer.className = "glow";
  layer.dataset.testid = "glow";
  layer.style.inset = `${-overhang * 100}%`;
  const canvases = [0, 1].map(() => {
    const canvas = document.createElement("canvas");
    canvas.width = sampleWidth;
    canvas.height = sampleHeight;
    canvas.className = "glow-canvas";
    canvas.style.transition = `opacity ${crossfadeMs}ms ease-in-out, filter ${crossfadeMs}ms ease-in-out`;
    layer.append(canvas);
    return canvas;
  });
  const contexts = canvases.map((canvas) =>
    canvas.getContext("2d", { willReadFrequently: true, alpha: false }),
  );
  host.prepend(layer);
  let waiting = false;
  let active = -1;
  let timer: ReturnType<typeof setInterval> | null = null;

  const paint = () => {
    const scale = host.clientWidth / frameSize.width;
    canvases.forEach((canvas, index) => {
      canvas.style.filter = `blur(${Math.round(blur * scale)}px)${waiting ? " saturate(1.2)" : ""}`;
      canvas.style.opacity =
        index === active ? String(waiting ? waitingOpacity : restOpacity) : "0";
    });
  };

  const sample = () => {
    const video = source();
    if (document.hidden || video === null || video.readyState < 2) return;
    const next = active === 0 ? 1 : 0;
    const canvas = canvases[next];
    const context = contexts[next];
    if (canvas === undefined || context == null) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let red = 0;
    let green = 0;
    let blue = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      red += pixels[i] ?? 0;
      green += pixels[i + 1] ?? 0;
      blue += pixels[i + 2] ?? 0;
    }
    const count = canvas.width * canvas.height;
    const color = normalizeGlowColor(red / count, green / count, blue / count, strength);
    if (color === null) return;
    onColor(`rgb(${color.join(", ")})`);
    active = next;
    paint();
  };

  const stop = () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };

  paint();
  return {
    start: () => {
      stop();
      sample();
      timer = setInterval(sample, intervalMs);
    },
    stop,
    sample,
    setWaiting: (value) => {
      if (value === waiting) return;
      waiting = value;
      paint();
    },
    destroy: () => {
      stop();
      layer.remove();
    },
  };
}

/**
 * Pulls an average color toward a vivid color of the same hue in Lab space, so a muddy frame still
 * casts a clear light. Null for a pure grey, which has no hue to cast.
 */
export function normalizeGlowColor(
  red: number,
  green: number,
  blue: number,
  strength = 0.5,
): [number, number, number] | null {
  const hue = hueOf(red, green, blue);
  if (!Number.isFinite(hue)) return null;
  const pure = labFromRGB(...rgbFromHue(hue));
  const target: [number, number, number] = [80 + (pure[0] - 80) * 0.5, pure[1], pure[2]];
  const original = labFromRGB(red, green, blue);
  const mix = (index: 0 | 1 | 2) => original[index] + (target[index] - original[index]) * strength;
  return rgbFromLab(mix(0), mix(1), mix(2));
}

function hueOf(red: number, green: number, blue: number): number {
  const max = Math.max(red, green, blue);
  const delta = max - Math.min(red, green, blue);
  if (delta === 0) return Number.NaN;
  const sector =
    max === red
      ? ((green - blue) / delta) % 6
      : max === green
        ? (blue - red) / delta + 2
        : (red - green) / delta + 4;
  return (sector * 60 + 360) % 360;
}

function rgbFromHue(hue: number): [number, number, number] {
  const x = 1 - Math.abs(((hue / 60) % 2) - 1);
  const rows: [number, number, number][] = [
    [1, x, 0],
    [x, 1, 0],
    [0, 1, x],
    [0, x, 1],
    [x, 0, 1],
    [1, 0, x],
  ];
  const row = rows[Math.floor(hue / 60) % 6] ?? [1, x, 0];
  return [row[0] * 255, row[1] * 255, row[2] * 255];
}

const epsilon = 216 / 24389;
const kappa = 24389 / 27;

function toLinear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function fromLinear(value: number): number {
  const clamped = Math.min(1, Math.max(0, value));
  const encoded = clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

function labFromRGB(red: number, green: number, blue: number): [number, number, number] {
  const linearRed = toLinear(red);
  const linearGreen = toLinear(green);
  const linearBlue = toLinear(blue);
  const x = (0.4124564 * linearRed + 0.3575761 * linearGreen + 0.1804375 * linearBlue) / 0.95047;
  const y = 0.2126729 * linearRed + 0.7151522 * linearGreen + 0.072175 * linearBlue;
  const z = (0.0193339 * linearRed + 0.119192 * linearGreen + 0.9503041 * linearBlue) / 1.08883;
  const f = (t: number) => (t > epsilon ? Math.cbrt(t) : (kappa * t + 16) / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

function rgbFromLab(
  lightness: number,
  greenRed: number,
  blueYellow: number,
): [number, number, number] {
  const inverse = (t: number) => (t ** 3 > epsilon ? t ** 3 : (116 * t - 16) / kappa);
  const fy = (lightness + 16) / 116;
  const x = inverse(fy + greenRed / 500) * 0.95047;
  const y = inverse(fy);
  const z = inverse(fy - blueYellow / 200) * 1.08883;
  return [
    fromLinear(3.2404542 * x - 1.5371385 * y - 0.4985314 * z),
    fromLinear(-0.969266 * x + 1.8760108 * y + 0.041556 * z),
    fromLinear(0.0556434 * x - 0.2040259 * y + 1.0572252 * z),
  ];
}
