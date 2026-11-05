import { z } from "zod";

export const Usage = z.object({
  input_tokens: z.number(),
  output_tokens: z.number(),
  input_tokens_details: z.object({ cached_tokens: z.number() }).optional(),
});

export const Capture = z.object({
  format: z.string(),
  hint: z.string(),
  aborted: z.boolean(),
  deltas: z.array(z.object({ ms: z.number(), text: z.string() })),
  doneMs: z.number(),
  usage: Usage.nullable(),
});
export type Capture = z.infer<typeof Capture>;

export const Fixture = z.object({ source: z.string(), captures: z.array(Capture) });
export type Fixture = z.infer<typeof Fixture>;
