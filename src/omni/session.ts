import { Reactor, type FileRef, type ReactorStatus } from "@reactor-team/js-sdk";
import { z } from "zod";
import { captureFile } from "../capture/index.ts";
import { record, retryOnce, withDeadline } from "../run-log/index.ts";
import { parseMessage, type ClipInfo, type ClipSeconds, type OmniMessage } from "./messages.ts";

export type SessionStatus = "idle" | "minting" | ReactorStatus | "ended" | "failed";

/** The Omni model every session runs. */
export const omniModel = "reactor/fast-h3-omni";
const Token = z.object({ jwt: z.string(), expires_at: z.number() });
const HostedToken = z.object({ jwt: z.string(), lease: z.string() });
const HostedRefusal = z.object({ error: z.string() });

/**
 * How sessions reach Reactor: with the visitor's own key, which mints tokens in the browser, or
 * through this site's Worker (`baseURL`, every call sent with `fetch`, which carries the pass),
 * which mints one token per session against a lease and ends the session with its own key.
 */
/**
 * How a session reaches Reactor: tokens minted with the own key, or leases from this site's
 * Worker, whose `ready` resolves once the browser holds a hosted-play pass (false when it could
 * not earn one), so the mint's deadline never counts the challenge.
 */
export type ReactorAccess =
  | { kind: "key"; key: string }
  | { kind: "hosted"; baseURL: string; fetch: typeof fetch; ready: () => Promise<boolean> };
type HostedAccess = Extract<ReactorAccess, { kind: "hosted" }>;

/** Parameters of one enqueue; see the model contract for each field's rules. */
export interface EnqueueRequest {
  prompt: string;
  seconds: ClipSeconds;
  metadata?: string;
  continueFromClipID?: string;
  continueMode?: "latent" | "frame";
  position?: number;
  referenceImages?: readonly FileRef[];
  firstFrameImage?: FileRef;
}

export type { FileRef };

type MessageListener = (message: OmniMessage) => void;
type StatusListener = (status: SessionStatus) => void;

/** Everything the app needs from a video model session; a mock implements the same surface. */
export interface OmniClient {
  readonly stream: MediaStream;
  readonly status: SessionStatus;
  onMessage: (listener: MessageListener) => () => void;
  onStatus: (listener: StatusListener) => () => void;
  start: () => Promise<void>;
  enqueue: (request: EnqueueRequest) => Promise<ClipInfo | null>;
  play: (clipID: string) => Promise<void>;
  end: (reason: string) => Promise<void>;
  stop: () => Promise<void>;
  pop: (clipID: string) => Promise<void>;
  move: (clipID: string, position: number) => Promise<void>;
  uploadFile: (file: Blob, name: string) => Promise<FileRef>;
  requestRecording: () => Promise<unknown>;
  /** Sends the server-side terminate as a request that outlives the page, for unload. */
  terminateOnUnload: () => void;
  /**
   * The media of this session's nth built clip, counted from 1, read from the step results once
   * the server has saved them: the clip with its audio and its last frame as a PNG. The mock keeps
   * no step results, so its moments are never captured.
   */
  stepResult?: (step: number, clipID: string, signal: AbortSignal) => Promise<StepMedia>;
}

/** One built clip's media from the step results. */
export interface StepMedia {
  step: number;
  clip: Blob;
  lastFrame: Blob;
  /** Milliseconds from the first ask until the step was listed, and then until both downloads. */
  listedMs: number;
  downloadedMs: number;
}

/** Makes one session for an access: a live Omni session, or the stand-in. */
export type OmniFactory = (access: ReactorAccess) => OmniClient;

/**
 * The factory for this page's sessions: live Omni sessions, or with `mock` the stand-in, with its
 * injected faults and every mocked wait stretched by `delays`, loaded only when it is asked for.
 */
export async function loadOmniFactory(
  mock: { faults: string | null; delays: number } | null,
): Promise<OmniFactory> {
  if (mock === null) return (access) => new OmniSession(access);
  const { MockOmni, parseMockFaults } = await import("./mock.ts");
  const faults = parseMockFaults(mock.faults);
  return () => new MockOmni(faults, mock.delays);
}

/** Deadlines in milliseconds, set from measured timings with headroom. */
export const omniDeadlines = {
  tokenMint: 5000,
  connectReady: 20000,
  command: 5000,
  build: 8000,
  playStart: 3000,
  upload: 8000,
  recording: 5000,
  disconnect: 3000,
  terminate: 3000,
  stepListed: 6000,
  stepDownload: 30000,
} as const;

const stepPollMs = 150;

const StepListing = z.object({
  files: z.array(z.object({ name: z.string(), url: z.string() })),
});

const StepReport = z.looseObject({
  messages: z
    .array(
      z.looseObject({
        type: z.string(),
        data: z.looseObject({ clip: z.looseObject({ clip_id: z.string() }).optional() }).optional(),
      }),
    )
    .optional(),
});

/**
 * Polls one step result until the server lists its files (202 means not saved yet), under the
 * listing deadline, then downloads the clip, its last frame and its report in parallel under the
 * download deadline. Rejects when the report names another clip as generated in that step, so a
 * caller never films from the wrong media.
 */
export async function readStep(
  authorization: Record<string, string>,
  sessionID: string,
  step: number,
  clipID: string,
  signal: AbortSignal,
): Promise<StepMedia> {
  const started = performance.now();
  const listing = await withDeadline("step_listed", omniDeadlines.stepListed, async (deadline) => {
    const both = AbortSignal.any([signal, deadline]);
    for (;;) {
      const response = await fetch(`${sessionURL(sessionID)}/steps/${step}`, {
        headers: authorization,
        signal: both,
      });
      if (response.status === 200) return StepListing.parse(await response.json());
      await response.body?.cancel();
      if (response.status !== 202) throw new Error(`step ${step} answered HTTP ${response.status}`);
      await new Promise((resolve) => setTimeout(resolve, stepPollMs));
      both.throwIfAborted();
    }
  });
  const listedMs = Math.round(performance.now() - started);
  const url = (name: string) => {
    const found = listing.files.find((file) => file.name === name)?.url;
    if (found === undefined) throw new Error(`step ${step} has no ${name}`);
    return found;
  };
  const [clip, lastFrame, report] = await withDeadline(
    "step_download",
    omniDeadlines.stepDownload,
    (deadline) => {
      const both = AbortSignal.any([signal, deadline]);
      const download = async (name: string) => {
        const response = await fetch(url(name), { signal: both });
        if (!response.ok) throw new Error(`${name} answered HTTP ${response.status}`);
        return response.blob();
      };
      return Promise.all([
        download("output.mp4"),
        download("last_frame.png"),
        listing.files.some((file) => file.name === "result.json")
          ? download("result.json").then(async (blob) => blob.text())
          : Promise.resolve(null),
      ]);
    },
  );
  if (report !== null) {
    captureFile(`steps/${String(step)}-${clipID.slice(0, 8)}.json`, report);
    const parsed = StepReport.safeParse(JSON.parse(report));
    const generated = (parsed.success ? (parsed.data.messages ?? []) : [])
      .filter((message) => message.type === "clip_generated")
      .flatMap((message) => (message.data?.clip === undefined ? [] : [message.data.clip.clip_id]));
    if (generated.length > 0 && !generated.includes(clipID))
      throw new Error(`step ${step} generated ${generated.join(", ")}, not ${clipID}`);
  }
  return {
    step,
    clip,
    lastFrame,
    listedMs,
    downloadedMs: Math.round(performance.now() - started) - listedMs,
  };
}

const terminateAttempts = 3;
const terminateBackoffMs = 400;

function sessionURL(sessionID: string): string {
  return `https://api.reactor.inc/sessions/${sessionID}`;
}

/**
 * Terminates a session through the API, which answers 200 for a session already closed. A 409
 * (close contended) or 5xx answer, a network failure or a missed deadline is retried a bounded
 * number of times; each failed attempt is logged.
 */
export async function terminateSession(
  apiKey: string,
  sessionID: string,
): Promise<{ terminated: boolean; attempts: number; status: number | null }> {
  let status: number | null = null;
  for (let attempt = 1; attempt <= terminateAttempts; attempt++) {
    try {
      const response = await fetch(sessionURL(sessionID), {
        method: "DELETE",
        headers: { "Reactor-API-Key": apiKey },
        signal: AbortSignal.timeout(omniDeadlines.terminate),
      });
      status = response.status;
      if (response.ok || response.status === 404)
        return { terminated: true, attempts: attempt, status };
      const retryable = response.status === 409 || response.status >= 500;
      record("omni_terminate_failed", {
        sessionID,
        attempt,
        status,
        body: (await response.text().catch(() => "")).slice(0, 200),
        retrying: retryable && attempt < terminateAttempts,
      });
      if (!retryable) return { terminated: false, attempts: attempt, status };
    } catch (error: unknown) {
      record("omni_terminate_failed", {
        sessionID,
        attempt,
        status: null,
        message: String(error),
        retrying: attempt < terminateAttempts,
      });
    }
    if (attempt < terminateAttempts)
      await new Promise((resolve) => setTimeout(resolve, terminateBackoffMs * attempt));
  }
  return { terminated: false, attempts: terminateAttempts, status };
}

async function mintToken(
  apiKey: string,
  maxSessionSeconds: number,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch("https://api.reactor.inc/tokens", {
    signal,
    method: "POST",
    headers: { "Reactor-API-Key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      expires_after: 3600,
      authorization_details: [
        {
          type: "session",
          resources: { models: { match: [omniModel] } },
          constraints: { max_sessions: 2, max_session_duration_seconds: maxSessionSeconds },
        },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Reactor token mint failed with HTTP ${response.status}`);
  return Token.parse(await response.json()).jwt;
}

async function mintHosted(
  access: HostedAccess,
  signal: AbortSignal,
): Promise<{ jwt: string; lease: string }> {
  const response = await access.fetch(`${access.baseURL}/api/reactor/token`, {
    signal,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const refusal = HostedRefusal.safeParse(body);
    throw new Error(
      refusal.success ? refusal.data.error : `Hosted token failed with HTTP ${response.status}`,
    );
  }
  return HostedToken.parse(body);
}

/** Tells the Worker which session a lease's token created, so it can end it later. */
async function registerHosted(
  access: HostedAccess,
  lease: string,
  sessionID: string,
): Promise<void> {
  const response = await access.fetch(`${access.baseURL}/api/reactor/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ lease, sessionID }),
    signal: AbortSignal.timeout(omniDeadlines.command),
  });
  await response.body?.cancel();
  if (!response.ok) throw new Error(`register answered HTTP ${response.status}`);
}

/** Ends a hosted session through the Worker, which terminates it with its key and frees the lease. */
async function endHosted(
  access: HostedAccess,
  lease: string,
  sessionID: string | null,
  keepalive: boolean,
): Promise<{ terminated: boolean; attempts: number; status: number | null }> {
  const response = await access.fetch(`${access.baseURL}/api/reactor/end`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sessionID === null ? { lease } : { lease, sessionID }),
    keepalive,
    ...(keepalive ? {} : { signal: AbortSignal.timeout(omniDeadlines.terminate * 3) }),
  });
  await response.body?.cancel();
  return { terminated: response.ok, attempts: 1, status: response.status };
}

/**
 * One FastH3-Omni session: mints a scoped token (with the browser's own key, or from the Worker
 * against a lease), connects, holds the last frame between clips, and plays clips only when asked
 * by id.
 */
export class OmniSession implements OmniClient {
  readonly stream = new MediaStream();
  status: SessionStatus = "idle";
  private reactor: Reactor | null = null;
  private sessionID: string | null = null;
  private jwt: string | null = null;
  private lease: string | null = null;
  private closed = false;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly statusListeners = new Set<StatusListener>();

  constructor(
    private readonly access: ReactorAccess,
    private readonly maxSessionSeconds = 1200,
  ) {}

  /** The REST credential for this session: the own key, or the token that created it. */
  private authorization(): Record<string, string> {
    return this.access.kind === "key"
      ? { "Reactor-API-Key": this.access.key }
      : { Authorization: `Bearer ${this.jwt ?? ""}` };
  }

  private async mint(signal: AbortSignal): Promise<string> {
    if (this.access.kind === "key")
      return mintToken(this.access.key, this.maxSessionSeconds, signal);
    const hosted = await mintHosted(this.access, signal);
    this.lease = hosted.lease;
    record("omni_lease", { lease: hosted.lease });
    return hosted.jwt;
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
    record("omni_status", { status });
    for (const listener of this.statusListeners) listener(status);
  }

  /** Mints a token, connects, and configures playback: flush off, autoplay off. */
  async start(): Promise<void> {
    this.setStatus("minting");
    if (this.access.kind === "hosted") await this.access.ready();
    const jwt =
      this.access.kind === "key"
        ? await retryOnce("token_mint", () =>
            withDeadline("token_mint", omniDeadlines.tokenMint, (signal) => this.mint(signal)),
          )
        : await withDeadline("token_mint", omniDeadlines.tokenMint, (signal) => this.mint(signal));
    this.jwt = jwt;
    if (this.status === "ended") return;
    const reactor = new Reactor({
      modelName: omniModel,
      modelTracks: [
        { name: "main_video", kind: "video", direction: "recvonly" },
        { name: "main_audio", kind: "audio", direction: "recvonly" },
      ],
    });
    this.reactor = reactor;
    reactor.on("statusChanged", (status) => {
      this.setStatus(status);
    });
    reactor.on("sessionIdChanged", (sessionID) => {
      record("omni_session_id", { sessionID: sessionID ?? null });
      if (sessionID === undefined) return;
      this.sessionID = sessionID;
      const { access, lease } = this;
      if (access.kind === "hosted" && lease !== null)
        void registerHosted(access, lease, sessionID).catch((error: unknown) => {
          record("omni_register_failed", { sessionID, message: String(error) });
        });
    });
    reactor.on("error", (error) => {
      record("omni_error", { code: error.code, message: error.message });
    });
    reactor.on("trackReceived", (name, track) => {
      record("omni_track", { name, kind: track.kind });
      for (const existing of this.stream.getTracks())
        if (existing.kind === track.kind) this.stream.removeTrack(existing);
      this.stream.addTrack(track);
    });
    reactor.on("message", (raw) => {
      record("omni_message", { raw });
      const { message, type } = parseMessage(raw);
      if (message === null) {
        record("omni_message_unmodeled", { type });
        return;
      }
      for (const listener of this.messageListeners) listener(message);
    });
    await withDeadline("connect_ready", omniDeadlines.connectReady, () => reactor.connect(jwt));
    await Promise.all([
      this.command("set_flush_on_clip_end", { enabled: false }),
      this.command("set_autoplay", { enabled: false }),
    ]);
    record("omni_configured", { flushOnClipEnd: false, autoplay: false });
  }

  private async command(name: string, data: Record<string, unknown>): Promise<unknown> {
    const reactor = this.reactor;
    if (reactor === null) return undefined;
    record("omni_command", { name, data });
    return retryOnce(name, () =>
      withDeadline(name, omniDeadlines.command, () => reactor.sendCommand(name, data)),
    );
  }

  /**
   * Enqueues a clip and resolves its record, or null when the model refused it. Never retried, so
   * a lost reply cannot queue the same clip twice; a missed deadline rejects.
   */
  async enqueue(request: EnqueueRequest): Promise<ClipInfo | null> {
    const reactor = this.reactor;
    if (reactor === null) return null;
    const data = {
      prompt: request.prompt,
      seconds: request.seconds,
      metadata: request.metadata ?? "",
      ...(request.position === undefined ? {} : { position: request.position }),
      ...(request.referenceImages === undefined || request.referenceImages.length === 0
        ? {}
        : { reference_images: [...request.referenceImages] }),
      ...(request.firstFrameImage === undefined
        ? {}
        : { first_frame_image: request.firstFrameImage }),
      ...(request.continueFromClipID === undefined
        ? {}
        : {
            continue_from_clip_id: request.continueFromClipID,
            continue_mode: request.continueMode ?? "latent",
          }),
    };
    record("omni_command", { name: "enqueue", data });
    const reply = await withDeadline("enqueue", omniDeadlines.command, () =>
      reactor.sendCommand("enqueue", data),
    );
    if (reply === undefined) return null;
    const { message } = parseMessage(reply);
    return message?.type === "clip_queued" ? message.clip : null;
  }

  /** Plays a ready clip by id. */
  async play(clipID: string): Promise<void> {
    await this.command("play", { clip_id: clipID });
  }

  /** Stops the playing clip; the player holds its frame and `clip_stopped` follows. */
  async stop(): Promise<void> {
    await this.command("stop", {});
  }

  /** Removes a clip from either queue; a build already running finishes and is discarded. */
  async pop(clipID: string): Promise<void> {
    await this.command("pop", { clip_id: clipID });
  }

  /** Moves a waiting clip in the generation queue; 0 is the next build. */
  async move(clipID: string, position: number): Promise<void> {
    await this.command("move", { clip_id: clipID, position });
  }

  /** Uploads an image for a reference or a pinned first frame. */
  async uploadFile(file: Blob, name: string): Promise<FileRef> {
    const reactor = this.reactor;
    if (reactor === null) throw new Error("upload before the session is connected");
    return withDeadline("upload", omniDeadlines.upload, () => reactor.uploadFile(file, { name }));
  }

  /** Asks the server for a recording of the whole session so far, as a backup. */
  async requestRecording(): Promise<unknown> {
    const reactor = this.reactor;
    if (reactor === null) throw new Error("no session to record");
    return withDeadline("request_recording", omniDeadlines.recording, () =>
      reactor.requestRecording(),
    );
  }

  /**
   * Ends the session: a non-recoverable disconnect under a deadline, then a terminate through the
   * API that retries a contended or failed close, so a disconnect stuck behind a connect or a
   * terminate the server refused still closes the session. `omni_closed` is logged once both are
   * done, with whether the server confirmed the close. Safe to call repeatedly.
   */
  async end(reason: string): Promise<void> {
    if (this.status === "ended") return;
    const reactor = this.reactor;
    this.setStatus("ended");
    record("omni_end", { reason });
    this.reactor = null;
    const started = performance.now();
    if (reactor !== null)
      await withDeadline("disconnect", omniDeadlines.disconnect, () =>
        reactor.disconnect(false),
      ).catch((error: unknown) => {
        record("omni_disconnect_failed", { message: String(error) });
      });
    const sessionID = this.sessionID;
    const access = this.access;
    const result =
      access.kind === "hosted"
        ? this.lease === null
          ? { terminated: false, attempts: 0, status: null }
          : await endHosted(access, this.lease, sessionID, false).catch((error: unknown) => {
              record("omni_terminate_failed", { sessionID, attempt: 1, message: String(error) });
              return { terminated: false, attempts: 1, status: null };
            })
        : sessionID === null
          ? { terminated: false, attempts: 0, status: null }
          : await terminateSession(access.key, sessionID);
    this.closed = true;
    record("omni_closed", {
      reason,
      sessionID,
      ...result,
      milliseconds: Math.round(performance.now() - started),
    });
  }

  /** The media of this session's nth built clip, from the step results. */
  async stepResult(step: number, clipID: string, signal: AbortSignal): Promise<StepMedia> {
    const sessionID = this.sessionID;
    if (sessionID === null) throw new Error("no session id for step results");
    return readStep(this.authorization(), sessionID, step, clipID, signal);
  }

  /**
   * Sends the terminate as a keepalive request, which the browser finishes after the page is gone,
   * for a session not yet closed. Called on unload, where nothing awaited would run.
   */
  terminateOnUnload(): void {
    const sessionID = this.sessionID;
    if (this.closed || (sessionID === null && this.lease === null)) return;
    record("omni_terminate_sent", { sessionID, keepalive: true });
    const access = this.access;
    if (access.kind === "hosted") {
      if (this.lease !== null)
        void endHosted(access, this.lease, sessionID, true).catch(() => undefined);
      return;
    }
    if (sessionID === null) return;
    void fetch(sessionURL(sessionID), {
      method: "DELETE",
      headers: { "Reactor-API-Key": access.key },
      keepalive: true,
    }).catch(() => undefined);
  }
}
