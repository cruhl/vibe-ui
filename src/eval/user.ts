import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { getClient, type OpenAIAccess } from "../agent/index.ts";
import { withDeadline } from "../run-log/index.ts";
import { fill } from "../text/index.ts";
import systemPrompt from "./user.md?raw";

/** A cheap, fast vision model, measured at about one second per decision with reasoning off. */
export const userModel = "gpt-5.4-nano";

/** Deadline in milliseconds for one simulated-user decision. */
export const userDeadline = 15000;

export const UserDecision = z.object({
  thought: z.string(),
  intent: z.string(),
  action: z.enum(["click", "type", "wait", "done"]),
  elementID: z.string().nullable(),
  x: z.number().nullable(),
  y: z.number().nullable(),
  text: z.string().nullable(),
  waitSeconds: z.number().nullable(),
  wordsRead: z.number(),
  goalProgress: z.number(),
});
export type UserDecision = z.infer<typeof UserDecision>;

export interface UserView {
  persona: string;
  frameBase64: string;
  boxes: { elementID: string; kind: string; label: string; box: unknown; presence: number }[];
  history: string[];
  inputsLeft: number;
  secondsLeft: number;
  playing: boolean;
}

export interface UserAnswer {
  decision: UserDecision;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

/**
 * Asks the simulated user for its next action on the current frame, through the app's shared
 * client: the eval fetch shim passes `user_decision` calls straight through, so they never hold the
 * content clock.
 */
export async function decide(openAI: OpenAIAccess, view: UserView): Promise<UserAnswer> {
  const current = getClient(openAI);
  const response = await withDeadline("eval_user", userDeadline, (signal) =>
    current.responses.parse(
      {
        model: userModel,
        reasoning: { effort: "none" },
        instructions: fill(systemPrompt.trim(), { persona: view.persona }),
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({
                  boxes: view.boxes,
                  history: view.history,
                  inputsLeft: view.inputsLeft,
                  secondsLeft: Math.round(view.secondsLeft),
                  animationPlaying: view.playing,
                }),
              },
              {
                type: "input_image",
                image_url: `data:image/jpeg;base64,${view.frameBase64}`,
                detail: "low",
              },
            ],
          },
        ],
        text: { format: zodTextFormat(UserDecision, "user_decision") },
      },
      { signal },
    ),
  );
  const usage = response.usage;
  return {
    decision: UserDecision.parse(response.output_parsed),
    inputTokens: usage?.input_tokens ?? 0,
    cachedTokens: usage?.input_tokens_details.cached_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
  };
}
