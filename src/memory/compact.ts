import { agentModel, getClient, type OpenAIAccess } from "../agent/index.ts";
import { record } from "../run-log/index.ts";
import { fill } from "../text/index.ts";
import compactPrompt from "./compact.md?raw";
import type { Compactor } from "./memory.ts";

/** The most words the story so far may have. */
const storyWords = 200;
const compactMs = 20_000;

/**
 * A compactor that has the agent model fold old history into the story so far, under
 * `compact.md`. Resolves to the old story when there is no access yet.
 */
export function agentCompactor(access: () => OpenAIAccess | null): Compactor {
  return async (story, lines) => {
    const openAI = access();
    if (openAI === null) return story ?? "";
    const started = performance.now();
    const response = await getClient(openAI).responses.create(
      {
        model: agentModel,
        reasoning: { effort: "none" },
        instructions: fill(compactPrompt.trim(), { words: String(storyWords) }),
        input: [`story so far: ${story ?? "(none yet)"}`, "history:", ...lines].join("\n"),
        max_output_tokens: storyWords * 3,
      },
      { signal: AbortSignal.timeout(compactMs) },
    );
    const text = response.output_text.trim();
    record("memory_compacted", {
      lines: lines.length,
      inputChars: lines.join("\n").length,
      storyChars: text.length,
      ms: Math.round(performance.now() - started),
    });
    return text;
  };
}
