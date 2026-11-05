import { z } from "zod";
import { setMockReplay } from "../omni/index.ts";
import { currentRoute } from "../route/index.ts";
import { record } from "../run-log/index.ts";
import { AgentReplay } from "./agent-replay.ts";
import { Fixture } from "./capture.ts";
import { installFetchShim } from "./fetch-shim.ts";

const KitClip = z.object({
  clipID: z.string(),
  prompt: z.string(),
  seconds: z.number(),
  buildSeconds: z.number().nullable(),
  video: z.string().nullable(),
});

const KitManifest = z.object({
  runID: z.string(),
  preset: z.string(),
  clips: z.array(KitClip),
  played: z.array(z.string()),
  jev: z.record(z.string(), z.array(z.unknown())),
  agent: Fixture,
});

async function loadVideo(url: string): Promise<HTMLVideoElement | null> {
  const response = await fetch(url).catch(() => null);
  if (response?.ok !== true) return null;
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.src = URL.createObjectURL(await response.blob());
  const loaded = await new Promise<boolean>((resolve) => {
    video.onloadeddata = () => {
      resolve(true);
    };
    video.onerror = () => {
      resolve(false);
    };
  });
  return loaded ? video : null;
}

/**
 * Replays a captured session through the app's own provider seams, for recordings that must not
 * wait on or pay for real calls: `?kit=<runID>` loads the kit `scripts/replay-kit.ts` built from
 * that session's bundle, then every Omni session is the mock playing the recorded footage of the
 * clip with the same prompt (else the next recorded clip in play order) after its measured build
 * time, Jev answers each question with its recorded answer, fal is mocked, and the agent replays
 * its recorded turns, loosely when the person does something the session never did. Every mocked
 * delay is stretched by `?delays=` (1 as measured, 0 at once). Installed before the controller so its first
 * session already runs on the kit; the app itself runs unchanged.
 */
export async function installKit(id: string): Promise<void> {
  const base = `/__dev/kit/${encodeURIComponent(id)}`;
  const response = await fetch(`${base}/manifest.json`);
  if (!response.ok) throw new Error(`no replay kit ${id}; build it with scripts/replay-kit.ts`);
  const manifest = KitManifest.parse(await response.json());
  const scale = currentRoute().delays;
  const videos = new Map<string, HTMLVideoElement>();
  await Promise.all(
    manifest.clips.map(async (clip) => {
      if (clip.video === null) return;
      const video = await loadVideo(`${base}/${clip.video}`);
      if (video !== null) videos.set(clip.clipID, video);
    }),
  );
  const byPrompt = new Map(manifest.clips.map((clip) => [clip.prompt, clip]));
  const played = manifest.played.flatMap((clipID) => {
    const video = videos.get(clipID);
    return video === undefined ? [] : [video];
  });
  setMockReplay({
    buildSeconds: (prompt) => byPrompt.get(prompt)?.buildSeconds ?? null,
    footage: (prompt, playIndex) =>
      videos.get(byPrompt.get(prompt)?.clipID ?? "") ??
      played[playIndex % Math.max(1, played.length)] ??
      null,
  });
  installFetchShim({
    jevMock: true,
    falMock: true,
    replay: new AgentReplay(manifest.agent, scale, true),
    jevAnswers: new Map(Object.entries(manifest.jev)),
    delayScale: scale,
  });
  record("kit_loaded", {
    runID: manifest.runID,
    preset: manifest.preset,
    clips: manifest.clips.length,
    footage: videos.size,
    delayScale: scale,
  });
}
