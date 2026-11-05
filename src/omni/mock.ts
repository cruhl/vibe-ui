import { FileRef } from "@reactor-team/js-sdk";
import { z } from "zod";
import { record } from "../run-log/index.ts";
import { clipSeconds, frameSize, type ClipInfo, type OmniMessage } from "./messages.ts";
import builds from "./mock-builds.json";
import { mockReplay } from "./replay.ts";
import type { EnqueueRequest, OmniClient, SessionStatus } from "./session.ts";

const Builds = z.object({ fresh: z.array(z.number()).min(1), continued: z.array(z.number()) });

/** Queue limits and timings of the real model, from the model contract and measured sessions. */
export const mockLimits = {
  generationCapacity: 20,
  playoutCapacity: 10,
  retainedSources: 8,
  replyMs: 170,
  playStartMs: 155,
  connectMs: 900,
  frameRate: 24,
} as const;

const { width, height } = frameSize;

let playCount = 0;

/**
 * Faults to inject, from the `mockFault` URL parameter as comma-separated entries:
 * `slow:<n>:<seconds>` builds the nth clip enqueued on any mock session in the page (from 1) in that many seconds, `black:<n>`
 * renders the nth clip black, `refuse:<n>` refuses the nth enqueue as the model would.
 */
export interface MockFaults {
  slow: Map<number, number>;
  black: Set<number>;
  refuse: Set<number>;
}

/** Parses the `mockFault` URL parameter; unknown entries are logged and skipped. */
export function parseMockFaults(value: string | null): MockFaults {
  const faults: MockFaults = { slow: new Map(), black: new Set(), refuse: new Set() };
  for (const entry of (value ?? "").split(",").filter((part) => part !== "")) {
    const [name, first, second] = entry.split(":");
    const index = Number(first);
    if (!Number.isInteger(index) || index < 1) {
      record("mock_fault_unknown", { entry });
      continue;
    }
    if (name === "slow" && Number(second) > 0) faults.slow.set(index, Number(second));
    else if (name === "black") faults.black.add(index);
    else if (name === "refuse") faults.refuse.add(index);
    else record("mock_fault_unknown", { entry });
  }
  return faults;
}

interface MockClip {
  info: ClipInfo;
  index: number;
  buildSeconds: number;
  footage: HTMLVideoElement | null;
}

let enqueueCount = 0;

type MessageListener = (message: OmniMessage) => void;
type StatusListener = (status: SessionStatus) => void;

function hashHue(text: string): number {
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) % 360;
  return hash;
}

function wrap(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (context.measureText(candidate).width > maxWidth && line !== "") {
      lines.push(line);
      line = word;
    } else line = candidate;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/**
 * A stand-in for FastH3-Omni with the real queue rules: a generation queue of 20, a playout queue
 * of 10 that pauses building when full, one build at a time, the five legal clip lengths, and
 * continuation only from one of the last 8 built clips. Refusals resolve null and broadcast
 * `command_error`, as the model does. Build times replay measured sessions. The video track is a
 * canvas showing each clip's prompt and id, held on its last frame between clips.
 */
export class MockOmni implements OmniClient {
  readonly stream = new MediaStream();
  status: SessionStatus = "idle";
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();
  private readonly canvas = document.createElement("canvas");
  private readonly generation: MockClip[] = [];
  private readonly playout: MockClip[] = [];
  private readonly sources: string[] = [];
  private building: MockClip | null = null;
  private buildTimer: ReturnType<typeof setTimeout> | null = null;
  private playing: { clip: MockClip; startedAt: number } | null = null;
  private frameTimer: ReturnType<typeof setInterval> | null = null;
  private freshCount = 0;
  private continuedCount = 0;
  private readonly builds = Builds.parse(builds);
  constructor(
    private readonly faults: MockFaults,
    private readonly scale = 1,
  ) {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  private setStatus(status: SessionStatus): void {
    if (this.status === "ended") return;
    this.status = status;
    record("omni_status", { status, mock: true });
    for (const listener of this.statusListeners) listener(status);
  }

  private emit(message: OmniMessage): void {
    if (this.status === "ended") return;
    for (const listener of this.messageListeners) listener(message);
  }

  private emitQueue(): void {
    this.emit({
      type: "queue_update",
      generation: this.generation.map((clip) => clip.info),
      playout: this.playout.map((clip) => clip.info),
    });
  }

  private refuse(command: string, reason: string): null {
    record("mock_refusal", { command, reason });
    this.emit({ type: "command_error", command, reason });
    return null;
  }

  private wait(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds * this.scale));
  }

  /** Connects after a short delay and starts the placeholder video track. */
  async start(): Promise<void> {
    this.setStatus("connecting");
    record("omni_session_id", { sessionID: `mock-${crypto.randomUUID()}` });
    await this.wait(mockLimits.connectMs);
    if (this.status === "ended") return;
    this.drawIdle();
    const track = this.canvas.captureStream(mockLimits.frameRate).getVideoTracks()[0];
    if (track !== undefined) {
      this.stream.addTrack(track);
      record("omni_track", { name: "main_video", kind: "video", mock: true });
    }
    this.setStatus("ready");
    record("omni_configured", { flushOnClipEnd: false, autoplay: false, mock: true });
  }

  private nextBuildSeconds(index: number, continued: boolean, prompt: string): number {
    const slow = this.faults.slow.get(index);
    if (slow !== undefined) return slow;
    const replayed = mockReplay()?.buildSeconds(prompt) ?? null;
    if (replayed !== null) return replayed * this.scale;
    const list =
      continued && this.builds.continued.length > 0 ? this.builds.continued : this.builds.fresh;
    const position = continued ? this.continuedCount++ : this.freshCount++;
    return (list[position % list.length] ?? 4) * this.scale;
  }

  /** Validates and queues a clip, or refuses it with the model's reason. */
  async enqueue(request: EnqueueRequest): Promise<ClipInfo | null> {
    await this.wait(mockLimits.replyMs);
    if (this.status === "ended") return null;
    const index = ++enqueueCount;
    if (this.faults.refuse.has(index))
      return this.refuse("enqueue", "request_rejected: injected refusal");
    if (request.prompt.trim() === "") return this.refuse("enqueue", "empty_prompt");
    if (!clipSeconds.some((seconds) => seconds === request.seconds))
      return this.refuse("enqueue", `invalid_seconds: ${request.seconds}`);
    if (this.generation.length >= mockLimits.generationCapacity)
      return this.refuse(
        "enqueue",
        "queue_full: The generation queue is full; pop a clip or wait.",
      );
    const source = request.continueFromClipID;
    if (source !== undefined && !this.sources.includes(source))
      return this.refuse("enqueue", `unknown_clip: ${source} is not a built, retained clip`);
    const info: ClipInfo = {
      clip_id: crypto.randomUUID(),
      prompt: request.prompt,
      metadata: request.metadata ?? "",
      frames: Math.round(request.seconds * 24),
      seconds: request.seconds,
      seed: null,
      ready: false,
      continue_mode: source === undefined ? null : (request.continueMode ?? "latent"),
      build_seconds: null,
    };
    const clip: MockClip = {
      info,
      index,
      buildSeconds: this.nextBuildSeconds(index, source !== undefined, request.prompt),
      footage: null,
    };
    const position = request.position;
    if (position !== undefined && (position < 0 || position > this.generation.length))
      return this.refuse("enqueue", `invalid_position: ${position}`);
    this.generation.splice(position ?? this.generation.length, 0, clip);
    this.emit({ type: "clip_queued", clip: info });
    this.emitQueue();
    this.pump();
    return info;
  }

  private pump(): void {
    if (this.building !== null || this.status === "ended") return;
    if (this.playout.length >= mockLimits.playoutCapacity) return;
    const next = this.generation[0];
    if (next === undefined) return;
    this.building = next;
    this.buildTimer = setTimeout(() => {
      this.finishBuild(next);
    }, next.buildSeconds * 1000);
  }

  private finishBuild(clip: MockClip): void {
    this.buildTimer = null;
    this.building = null;
    this.generation.splice(this.generation.indexOf(clip), 1);
    clip.info = { ...clip.info, ready: true, build_seconds: clip.buildSeconds };
    this.playout.push(clip);
    this.sources.push(clip.info.clip_id);
    while (this.sources.length > mockLimits.retainedSources) this.sources.shift();
    this.emit({ type: "clip_generated", clip: clip.info });
    this.emitQueue();
    this.pump();
  }

  /** Plays a built clip by id; refuses an unknown clip or a play while another clip plays. */
  async play(clipID: string): Promise<void> {
    await this.wait(mockLimits.playStartMs);
    if (this.status === "ended") return;
    if (this.playing !== null) {
      this.refuse("play", "already_playing");
      return;
    }
    const clip = this.playout.find((candidate) => candidate.info.clip_id === clipID);
    if (clip === undefined) {
      this.refuse("play", `unknown_clip: ${clipID}`);
      return;
    }
    this.playout.splice(this.playout.indexOf(clip), 1);
    clip.footage = mockReplay()?.footage(clip.info.prompt, playCount++) ?? null;
    if (clip.footage !== null) {
      clip.footage.currentTime = 0;
      void clip.footage.play().catch(() => undefined);
    }
    this.playing = { clip, startedAt: performance.now() };
    this.emit({ type: "clip_started", clip: clip.info });
    this.emitQueue();
    this.drawClip();
    this.frameTimer = setInterval(() => {
      this.drawClip();
    }, 1000 / mockLimits.frameRate);
    this.pump();
  }

  /** Stops the playing clip and holds its frame; refuses when nothing plays. */
  async stop(): Promise<void> {
    await this.wait(mockLimits.replyMs);
    const playing = this.playing;
    if (playing === null) {
      this.refuse("stop", "not_playing");
      return;
    }
    if (this.frameTimer !== null) clearInterval(this.frameTimer);
    this.frameTimer = null;
    this.playing = null;
    playing.clip.footage?.pause();
    const secondsSent = (performance.now() - playing.startedAt) / 1000;
    this.emit({ type: "clip_stopped", clip: playing.clip.info, seconds_sent: secondsSent });
    this.pump();
  }

  /** Removes a clip from either queue; a clip mid-build is discarded when its build ends. */
  async pop(clipID: string): Promise<void> {
    await this.wait(mockLimits.replyMs);
    for (const queue of [this.generation, this.playout]) {
      const clip = queue.find((candidate) => candidate.info.clip_id === clipID);
      if (clip === undefined) continue;
      queue.splice(queue.indexOf(clip), 1);
      if (this.building === clip) {
        if (this.buildTimer !== null) clearTimeout(this.buildTimer);
        this.buildTimer = null;
        this.building = null;
      }
      this.emit({ type: "clip_popped", clip: clip.info });
      this.emitQueue();
      this.pump();
      return;
    }
    this.refuse("pop", `unknown_clip: ${clipID}`);
  }

  /**
   * Moves a waiting clip in the generation queue. The clip being built is already first: moving it
   * to 0 is accepted and changes nothing, moving it anywhere else is refused.
   */
  async move(clipID: string, position: number): Promise<void> {
    await this.wait(mockLimits.replyMs);
    const clip = this.generation.find((candidate) => candidate.info.clip_id === clipID);
    if (clip === undefined) {
      this.refuse("move", `unknown_clip: ${clipID}`);
      return;
    }
    if (clip === this.building) {
      if (position !== 0) this.refuse("move", `invalid_position: ${position}`);
      return;
    }
    const offset = this.building === null ? 0 : 1;
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position + offset >= this.generation.length
    ) {
      this.refuse("move", `invalid_position: ${position}`);
      return;
    }
    this.generation.splice(this.generation.indexOf(clip), 1);
    this.generation.splice(position + offset, 0, clip);
    this.emitQueue();
  }

  /** Accepts an upload and returns a reference to it; the mock never reads the bytes. */
  async uploadFile(file: Blob, name: string): Promise<FileRef> {
    await this.wait(mockLimits.replyMs);
    return new FileRef(`mock-${crypto.randomUUID()}`, name, file.type, file.size);
  }

  /** The mock has no server recording. */
  async requestRecording(): Promise<unknown> {
    await this.wait(mockLimits.replyMs);
    return null;
  }

  /** The mock has no server session to terminate. */
  terminateOnUnload(): void {}

  private drawIdle(): void {
    const context = this.canvas.getContext("2d");
    if (context === null) return;
    context.fillStyle = mockReplay() === null ? "#4a4a4a" : "#000000";
    context.fillRect(0, 0, width, height);
    if (mockReplay() !== null) return;
    context.fillStyle = "#ffffff";
    context.font = "bold 36px sans-serif";
    context.fillText("MOCK OMNI: waiting for the first clip", 48, 80);
  }

  private drawClip(): void {
    const playing = this.playing;
    const context = this.canvas.getContext("2d");
    if (playing === null || context === null) return;
    const elapsed = (performance.now() - playing.startedAt) / 1000;
    const { info, index } = playing.clip;
    if (elapsed >= info.seconds) {
      this.finishPlay();
      return;
    }
    if (this.faults.black.has(index)) {
      context.fillStyle = "#000000";
      context.fillRect(0, 0, width, height);
      return;
    }
    const footage = playing.clip.footage;
    if (footage !== null) {
      if (footage.readyState >= 2) context.drawImage(footage, 0, 0, width, height);
      return;
    }
    context.fillStyle = `hsl(${hashHue(info.clip_id)}, 45%, 42%)`;
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#ffffff";
    context.font = "bold 34px sans-serif";
    context.fillText(`MOCK OMNI clip ${index}  ${info.clip_id.slice(0, 8)}`, 48, 64);
    context.font = "24px sans-serif";
    context.fillText(
      `${elapsed.toFixed(1)} / ${info.seconds} s, built in ${playing.clip.buildSeconds} s, ${info.continue_mode ?? "fresh"}`,
      48,
      104,
    );
    context.font = "22px sans-serif";
    const lines = wrap(context, info.prompt, width - 96).slice(0, 22);
    lines.forEach((line, i) => {
      context.fillText(line, 48, 156 + i * 28);
    });
    context.fillStyle = "rgba(255, 255, 255, 0.85)";
    context.fillRect(48, height - 36, (width - 96) * (elapsed / info.seconds), 12);
  }

  private finishPlay(): void {
    const playing = this.playing;
    if (playing === null) return;
    if (this.frameTimer !== null) clearInterval(this.frameTimer);
    this.frameTimer = null;
    this.playing = null;
    playing.clip.footage?.pause();
    this.emit({
      type: "clip_finished",
      clip: playing.clip.info,
      seconds_sent: playing.clip.info.seconds,
    });
    this.pump();
  }

  /** Ends the mock session, stops the track and every timer. Safe to call repeatedly. */
  async end(reason: string): Promise<void> {
    if (this.status === "ended") return;
    this.setStatus("ended");
    record("omni_end", { reason, mock: true });
    if (this.buildTimer !== null) clearTimeout(this.buildTimer);
    if (this.frameTimer !== null) clearInterval(this.frameTimer);
    for (const track of this.stream.getTracks()) track.stop();
    await Promise.resolve();
    record("omni_closed", { reason, sessionID: null, terminated: true, mock: true });
  }
}
