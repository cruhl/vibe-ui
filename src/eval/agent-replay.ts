import { z } from "zod";
import { record } from "../run-log/index.ts";
import { Capture, Usage, type Fixture } from "./capture.ts";

const StreamEvent = z.looseObject({ type: z.string() });
const Delta = z.object({ type: z.literal("response.output_text.delta"), delta: z.string() });
const Completed = z.object({
  type: z.literal("response.completed"),
  response: z.looseObject({ usage: Usage.nullable().optional() }),
});

/**
 * The format name and the turn of an agent request body, or null when it is not an agent call. A
 * line-format call has no structured format: it is named `lines` and its turn is the `turn:` and
 * `input:` lines of its input text.
 */
export function readAgentRequest(body: unknown): { format: string; hint: string } | null {
  const lines = z
    .looseObject({ instructions: z.string(), input: z.string(), text: z.undefined().optional() })
    .safeParse(body);
  if (lines.success) return { format: "lines", hint: linesHint(lines.data.input) };
  const parsed = z
    .looseObject({
      input: z.unknown(),
      text: z.object({ format: z.object({ name: z.string() }) }),
    })
    .safeParse(body);
  if (!parsed.success) return null;
  let hint = "";
  if (typeof parsed.data.input === "string") {
    const input = z.looseObject({ turn: z.unknown() }).safeParse(safeJSON(parsed.data.input));
    hint = input.success ? JSON.stringify(input.data.turn) : "";
  }
  return { format: parsed.data.text.format.name, hint };
}

function linesHint(input: string): string {
  const field = (name: string) =>
    input
      .split("\n")
      .find((line) => line.startsWith(`${name}: `))
      ?.slice(name.length + 2) ?? "";
  return `${field("turn")}|${field("input")}`;
}

function safeJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Passes a streamed agent response through unchanged while capturing its text deltas and usage on
 * the content clock, timed from `startedAt`, when the request was sent; logs one `agent_capture` event when the stream ends or is cut.
 */
export function captureStream(
  response: Response,
  request: { format: string; hint: string },
  onEnd: () => void,
  startedAt: number,
): Response {
  const body = response.body;
  if (body === null) {
    onEnd();
    return response;
  }
  const decoder = new TextDecoder();
  const deltas: Capture["deltas"] = [];
  let usage: Capture["usage"] = null;
  let buffer = "";
  let finished = false;
  const finish = (aborted: boolean) => {
    if (finished) return;
    finished = true;
    onEnd();
    const capture: Capture = {
      ...request,
      aborted,
      deltas,
      doneMs: Math.round(performance.now() - startedAt),
      usage,
    };
    record("agent_capture", { capture });
  };
  const readEvents = () => {
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      const data = part
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      const event = StreamEvent.safeParse(safeJSON(data));
      if (!event.success) continue;
      const delta = Delta.safeParse(event.data);
      if (delta.success)
        deltas.push({ ms: Math.round(performance.now() - startedAt), text: delta.data.delta });
      const completed = Completed.safeParse(event.data);
      if (completed.success) usage = completed.data.response.usage ?? null;
    }
  };
  const transformed = body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        buffer += decoder.decode(chunk, { stream: true });
        readEvents();
        controller.enqueue(chunk);
      },
      flush() {
        finish(false);
      },
    }),
  );
  const reader = transformed.getReader();
  const passthrough = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error: unknown) {
        finish(true);
        controller.error(error);
      }
    },
    cancel(reason) {
      finish(true);
      return reader.cancel(reason);
    },
  });
  return new Response(passthrough, { status: response.status, headers: response.headers });
}

interface TimedLine {
  ms: number;
  line: string;
}

/** A recorded reply cut into the lines it streamed, each at the moment its newline arrived. */
function timedLines(capture: Capture): TimedLine[] {
  const result: TimedLine[] = [];
  let pending = "";
  for (const delta of capture.deltas) {
    const parts = `${pending}${delta.text}`.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) if (part.trim() !== "") result.push({ ms: delta.ms, line: part });
  }
  if (pending.trim() !== "")
    result.push({ ms: capture.deltas.at(-1)?.ms ?? capture.doneMs, line: pending });
  return result;
}

function asCapture(request: { format: string; hint: string }, lines: TimedLine[]): Capture {
  return {
    ...request,
    aborted: false,
    deltas: lines.map((item) => ({ ms: item.ms, text: `${item.line}\n` })),
    doneMs: (lines.at(-1)?.ms ?? 0) + 20,
    usage: null,
  };
}

const guessHeader = /^\? ([a-z0-9-]+)\b/;

/**
 * Serves recorded agent replies in place of the model, matched by format and turn. A reply that
 * was cut in the recording streams up to its cut and then stays open, as the live stream would
 * have, until the app aborts it. A line-format turn the recording never made is built from what
 * it did record for the same input: a guessing turn from the guesses of a recorded answer, an
 * answer from the recorded guess block for the pressed button followed by the recorded guesses.
 */
export class AgentReplay {
  private readonly unused: Capture[];
  private readonly all: readonly Capture[];

  /**
   * `scale` stretches every recorded offset (1 as recorded, 0 at once); `loose` answers a turn the
   * recording has nothing for with its next unused reply of the same kind, then any reply of that
   * kind, so a cheat replay never stalls on an input the session never made.
   */
  constructor(
    fixture: Fixture,
    private readonly scale = 1,
    private readonly loose = false,
  ) {
    this.unused = [...fixture.captures];
    this.all = fixture.captures;
  }

  private takeLoose(request: { format: string; hint: string }): Capture | null {
    const turn = request.hint.split("|")[0] ?? "";
    const sameKind = (capture: Capture) =>
      capture.format === request.format && capture.hint.split("|")[0] === turn && !capture.aborted;
    const index = this.unused.findIndex(sameKind);
    if (index !== -1) return this.unused.splice(index, 1)[0] ?? null;
    return [...this.all].reverse().find(sameKind) ?? null;
  }

  private takeExact(format: string, hint: string): Capture | null {
    const index = this.unused.findIndex(
      (capture) => capture.format === format && capture.hint === hint,
    );
    if (index === -1) return null;
    const [capture] = this.unused.splice(index, 1);
    return capture ?? null;
  }

  private guessBlock(elementID: string): TimedLine[] | null {
    for (const capture of [...this.all].reverse()) {
      const lines = timedLines(capture);
      const start = lines.findIndex((item) => guessHeader.exec(item.line)?.[1] === elementID);
      if (start === -1) continue;
      const rest = lines.slice(start + 1);
      const end = rest.findIndex((item) => guessHeader.test(item.line));
      const block = end === -1 ? rest : rest.slice(0, end);
      if (block.length > 0) return block;
    }
    return null;
  }

  private synthesize(request: { format: string; hint: string }): Capture | null {
    const [turn, input = ""] = request.hint.split("|");
    const other = this.takeExact(
      "lines",
      `${turn === "respond" ? "speculate" : "respond"}|${input}`,
    );
    const otherLines = other === null ? [] : timedLines(other);
    const firstGuess = otherLines.findIndex((item) => guessHeader.test(item.line));
    const guesses = firstGuess === -1 ? [] : otherLines.slice(firstGuess);
    if (turn === "speculate") return guesses.length === 0 ? null : asCapture(request, guesses);
    const elementID = /^click ([a-z0-9-]+) /.exec(input)?.[1];
    const block = elementID === undefined ? null : this.guessBlock(elementID);
    if (block === null) return null;
    const firstMs = block[0]?.ms ?? 0;
    const startMs = otherLines[0]?.ms ?? 800;
    const change = block.map((item) => ({ ms: startMs + item.ms - firstMs, line: item.line }));
    const shift = (change.at(-1)?.ms ?? startMs) - (guesses[0]?.ms ?? startMs) + 60;
    return asCapture(request, [
      ...change,
      ...guesses.map((item) => ({ ms: item.ms + Math.max(0, shift), line: item.line })),
    ]);
  }

  private take(request: { format: string; hint: string }): Capture | null {
    const exact = this.takeExact(request.format, request.hint);
    if (exact !== null) return exact;
    if (request.format === "lines") {
      const built = this.synthesize(request);
      if (built !== null) record("agent_replay_synthesized", { hint: request.hint });
      if (built !== null || !this.loose) return built;
      const loose = this.takeLoose(request);
      if (loose !== null) record("agent_replay_loose", { hint: request.hint, served: loose.hint });
      return loose;
    }
    const fallback = this.unused.findIndex((capture) => capture.format === request.format);
    if (fallback === -1) return null;
    const [capture] = this.unused.splice(fallback, 1);
    return capture ?? null;
  }

  /** A streamed response replaying one recorded reply at its recorded content-time offsets. */
  serve(request: { format: string; hint: string }, signal: AbortSignal | null): Response {
    const capture = this.take(request);
    if (capture === null) {
      record("agent_replay_exhausted", { format: request.format, hint: request.hint });
      return new Response(
        JSON.stringify({ error: { message: "agent replay has no reply for this turn" } }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    record("agent_replay_served", {
      format: capture.format,
      exactTurn: capture.hint === request.hint,
      deltas: capture.deltas.length,
      doneMs: capture.doneMs,
    });
    const encoder = new TextEncoder();
    const scale = this.scale;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const sse = (value: unknown) => encoder.encode(`data: ${JSON.stringify(value)}\n\n`);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const stop = () => {
          for (const timer of timers) clearTimeout(timer);
          controller.error(new DOMException("aborted", "AbortError"));
        };
        if (signal?.aborted === true) {
          stop();
          return;
        }
        signal?.addEventListener("abort", stop, { once: true });
        for (const delta of capture.deltas)
          timers.push(
            setTimeout(() => {
              controller.enqueue(sse({ type: "response.output_text.delta", delta: delta.text }));
            }, delta.ms * scale),
          );
        if (!capture.aborted)
          timers.push(
            setTimeout(
              () => {
                controller.enqueue(
                  sse({ type: "response.completed", response: { usage: capture.usage } }),
                );
                signal?.removeEventListener("abort", stop);
                controller.close();
              },
              Math.max(capture.doneMs, capture.deltas.at(-1)?.ms ?? 0) * scale,
            ),
          );
      },
      cancel() {
        for (const timer of timers) clearTimeout(timer);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  }
}
