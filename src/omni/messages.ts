import { z } from "zod";

/** The five clip lengths the model accepts; every other value is refused. */
export const clipSeconds = [5.875, 8, 10.125, 12.25, 14.375] as const;
export type ClipSeconds = (typeof clipSeconds)[number];

export const ClipInfo = z.looseObject({
  clip_id: z.string(),
  prompt: z.string(),
  metadata: z.string().optional(),
  frames: z.number().optional(),
  seconds: z.number(),
  seed: z.number().nullable().optional(),
  ready: z.boolean(),
  continue_mode: z.string().nullable().optional(),
  build_seconds: z.number().nullable().optional(),
});
export type ClipInfo = z.infer<typeof ClipInfo>;

const ClipMessage = <Type extends string>(type: Type) =>
  z.object({ type: z.literal(type), clip: ClipInfo });

export const OmniMessage = z.discriminatedUnion("type", [
  ClipMessage("clip_queued"),
  ClipMessage("clip_generated"),
  ClipMessage("clip_started"),
  ClipMessage("clip_popped"),
  ClipMessage("clip_finished").extend({ seconds_sent: z.number().optional() }),
  ClipMessage("clip_stopped").extend({ seconds_sent: z.number().optional() }),
  ClipMessage("clip_failed").extend({ reason: z.string().optional() }),
  z.object({ type: z.literal("command_error"), command: z.string(), reason: z.string() }),
  z.looseObject({
    type: z.literal("queue_update"),
    generation: z.array(ClipInfo),
    playout: z.array(ClipInfo),
  }),
  z.looseObject({
    type: z.literal("state_update"),
    playing: z.boolean(),
    playing_clip_id: z.string().nullable(),
    flush_on_clip_end: z.boolean(),
    autoplay: z.boolean(),
  }),
]);
export type OmniMessage = z.infer<typeof OmniMessage>;

const Envelope = z.object({ type: z.string(), data: z.unknown() });

/**
 * Flattens the SDK's `{ type, data }` envelope and parses a known message, or returns null with the
 * raw type for a message this client does not model.
 */
export function parseMessage(raw: unknown): { message: OmniMessage | null; type: string } {
  const envelope = Envelope.safeParse(raw);
  if (!envelope.success) return { message: null, type: "unknown" };
  const data = z.record(z.string(), z.unknown()).safeParse(envelope.data.data);
  const flat = { ...(data.success ? data.data : {}), type: envelope.data.type };
  const parsed = OmniMessage.safeParse(flat);
  return { message: parsed.success ? parsed.data : null, type: envelope.data.type };
}

/** The size of every frame Omni films, in pixels. */
export const frameSize = { width: 1344, height: 768 } as const;
