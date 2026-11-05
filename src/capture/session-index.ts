import { z } from "zod";
import { getEvents, getRunID, record, subscribe, withDeadline } from "../run-log/index.ts";
import { captureFile } from "./bundle.ts";

const buildStampMs = 3000;
const persistMs = 1500;

const BuildStamp = z.object({
  commit: z.string().nullable(),
  dirty: z.boolean().nullable(),
  changedFiles: z.number().nullable(),
});

/** The code a page load really ran: from the dev server at load time, else the bundle's stamp. */
export interface Build {
  commit: string | null;
  dirty: boolean | null;
  changedFiles: number | null;
  source: "dev-server" | "bundle";
}

/** The bundle's own stamp, until the dev server answers. */
export const bundleBuild: Build = {
  commit: import.meta.env.VITE_GIT_COMMIT,
  dirty: null,
  changedFiles: null,
  source: "bundle",
};

/** Reads the commit and dirty flag of the code this page load runs from the dev server. */
export async function stampBuild(): Promise<Build> {
  let build = bundleBuild;
  if (import.meta.env.DEV)
    try {
      const stamp = await withDeadline("build_stamp", buildStampMs, async (signal) => {
        const response = await fetch("/__dev/build", { signal });
        return BuildStamp.parse(await response.json());
      });
      build = { ...stamp, source: "dev-server" };
    } catch (error: unknown) {
      record("build_stamp_failed", { message: String(error) });
    }
  record("build_stamp", { ...build });
  return build;
}

/** One input on the bundle's timeline. */
export interface TimelineEntry {
  t: number;
  label: string;
  outcome: string;
  midClip: boolean;
  clipID: string | null;
  firstFrameAt: number | null;
  failed: string | null;
}

/** What a session's index says about it. */
export interface SessionInfo {
  scenario: string;
  models: { agent: string; jev: string | null; omni: string };
  poolSize: number;
  build: Build;
  inputs: readonly TimelineEntry[];
  endReason: string | null;
}

/** Writes the bundle's `session.json`: what ran, with which models and code, and a timeline. */
export function writeSessionIndex(info: SessionInfo): void {
  const events = getEvents();
  captureFile(
    "session.json",
    JSON.stringify(
      {
        runID: getRunID(),
        preset: info.scenario,
        models: info.models,
        poolSize: info.poolSize,
        build: info.build,
        userAgent: navigator.userAgent,
        startedAt: events.find((event) => event.kind === "run_start")?.at ?? null,
        endedAt: info.endReason === null ? null : new Date().toISOString(),
        endReason: info.endReason,
        sessionIDs: events
          .filter((event) => event.kind === "omni_session_id")
          .map((event) => event.sessionID)
          .filter((id) => typeof id === "string"),
        files: {
          runLog: "run-log.jsonl",
          recording: "recording.webm",
          agentReplay: "agent-replay.json",
          prompts: "prompts/<hash>.md (agent instructions), prompts/clip-<hash>.md (clip prompts)",
          clips: "clips/<clipID>.json (every enqueue's full parameters)",
          uploads: "uploads/<sequence>.jpg (every uploaded frame)",
          frames: "frames/<clipID>-<settled|held|1s|3s>.jpg",
          inputFrames: "inputs/<inputID>.jpg",
          jevFrames: "jev/<sequence>.jpg",
        },
        timeline: info.inputs.map((input) => ({
          t: input.t,
          label: input.label,
          outcome: input.outcome,
          midClip: input.midClip,
          clipID: input.clipID,
          firstFrameSeconds: input.firstFrameAt === null ? null : input.firstFrameAt - input.t,
          failed: input.failed,
        })),
      },
      null,
      2,
    ),
  );
}

/** Writes every agent turn as an eval agent-replay fixture, enough to replay without a browser. */
export function writeAgentReplay(): void {
  const captures = getEvents()
    .filter((event) => event.kind === "agent_turn")
    .map((event) => ({
      format: event.format,
      hint: event.hint,
      aborted: event.aborted,
      deltas: event.deltas,
      doneMs: event.doneMs,
      usage: event.usage,
    }));
  captureFile("agent-replay.json", JSON.stringify({ source: getRunID(), captures }, null, 2));
}

/**
 * Runs `write` shortly after the run log grows, while `running` holds, so a bundle is complete at
 * every moment and nothing depends on the session ending cleanly. Returns the stop.
 */
export function persistAsItGoes(running: () => boolean, write: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = subscribe(() => {
    timer ??= setTimeout(() => {
      timer = null;
      if (running()) write();
    }, persistMs);
  });
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
  };
}
