import { z } from "zod";
import { jsonBlock } from "../text/index.ts";

const Color = z.string().describe("A CSS color, such as #1a1200 or rgba(255, 223, 120, 0.9).");

const Sound = z.object({
  seconds: z.number().describe("Length to record, 0.4 to 1 for the click, 8 to 12 for the bed."),
  volume: z
    .number()
    .describe("Playback volume from 0 to 1: about 0.4 for the click, 0.15 for the bed."),
  prompt: z.string().describe("What the sound effects model records, as one plain sentence."),
});

/** How the busy panel is drawn: every value is a parameter of one generic panel, never a named style. */
export const BusyFrame = z.object({
  corners: z
    .array(z.number())
    .describe(
      "Corner radius in percent of the stage width: one value, or four for uneven corners.",
    ),
  borderWidth: z.number().describe("Border width in percent of the stage width, 0 to 0.6."),
  borderStyle: z.enum(["solid", "double", "dashed", "dotted", "none"]),
  panel: z.array(Color).describe("One to three panel colors, painted top to bottom."),
  shadow: z.enum(["none", "soft", "hard", "glow"]),
  bevel: z
    .boolean()
    .describe("A bright inner top edge and soft highlights, like polished or carved material."),
  textCase: z.enum(["upper", "as-written"]),
  weight: z.enum(["normal", "bold"]),
  letterSpacing: z.number().describe("Extra letter spacing in em, 0 to 0.1."),
  textEffect: z.enum(["none", "glow", "emboss"]),
  prefix: z.string().describe("Characters printed before the status line, often empty."),
  pixelated: z.boolean().describe("Draw the indicator art with hard square pixels."),
  tail: z.boolean().describe("A speech balloon tail under the panel."),
});
export type BusyFrame = z.infer<typeof BusyFrame>;

/** One layer of ambient life painted over the held frame: a generic effect placed by parameters. */
export const AmbientEffect = z.object({
  kind: z
    .enum(["scanlines", "flicker", "drift", "pulse", "waver", "shimmer"])
    .describe(
      "scanlines: rolling horizontal lines; flicker: the whole frame flickers; drift: soft light slowly drifts; pulse: a light at x, y breathes; waver: a light at x, y wavers like firelight; shimmer: a diagonal sheen sweeps across.",
    ),
  color: Color,
  x: z.number().describe("Center of a pulse or waver light, percent from the left."),
  y: z.number().describe("Center of a pulse or waver light, percent from the top."),
  width: z.number().describe("Width of a pulse or waver light in percent of the frame."),
  height: z.number().describe("Height of a pulse or waver light in percent of the frame."),
  opacity: z.number().describe("Strength from 0 to 1."),
  seconds: z.number().describe("Length of one cycle of the effect."),
  blend: z.enum(["normal", "screen", "multiply", "overlay"]),
});
export type AmbientEffect = z.infer<typeof AmbientEffect>;

/** One scenario's busy state: what the world shows and plays while it works on an answer. */
export const BusyKit = z.object({
  pitch: z
    .string()
    .describe("One short sentence, a dozen words at most, that sells the world on the picker."),
  acknowledge: z
    .enum(["press", "brighten", "wobble"])
    .describe("How a chosen thing reacts on the video at once."),
  font: z.string().describe("A CSS font family stack that suits the world."),
  colors: z.object({
    ink: Color,
    panel: Color,
    edge: Color,
    accent: Color,
    glow: Color,
  }),
  frame: BusyFrame,
  place: z.enum(["top", "bottom", "top-left", "top-right", "bottom-left", "bottom-right"]),
  indicator: z.object({
    motion: z.enum(["flip", "spin", "pulse", "twinkle", "bob"]),
    seconds: z.number().describe("Length of one cycle of the motion."),
    prompt: z
      .string()
      .describe(
        "What the image model paints for the indicator: one object in the world's style, centered, isolated on a plain white background.",
      ),
  }),
  phases: z
    .object({
      opening: z.string(),
      thinking: z.string(),
      writing: z.string(),
      filming: z.string(),
      arriving: z.string(),
      slow: z.string(),
    })
    .describe(
      "The status line for each moment of the wait, a few words each in the world's voice, never saying what the answer will show.",
    ),
  ambient: z.array(AmbientEffect),
  sounds: z.object({ click: Sound, bed: Sound }),
});
export type BusyKit = z.infer<typeof BusyKit>;

/** The file names of a scenario's busy art, the same for every scenario. */
export const busyFiles = {
  indicator: "indicator.png",
  click: "click.mp3",
  bed: "bed.mp3",
} as const;
export type BusyFileName = keyof typeof busyFiles;

/** Reads the one JSON block of a `busy.md` and checks it. */
export function parseBusyMarkdown(markdown: string): BusyKit {
  const block = jsonBlock(markdown);
  if (block === null) throw new Error("busy.md has no json block");
  return BusyKit.parse(block.json);
}

/** Writes a busy kit as a `busy.md`, the same shape every scenario folder holds. */
export function busyMarkdown(name: string, kit: BusyKit): string {
  return `# ${name}: busy state\n\nWhat the world shows while it works on an answer, written once as content. Code only plays it:\nthe indicator art and sounds in \`busy/\` are painted and recorded from the prompts below.\n\n\`\`\`json\n${JSON.stringify(kit, null, 2)}\n\`\`\`\n`;
}
