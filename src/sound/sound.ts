import { record, withDeadline } from "../run-log/index.ts";

/** Deadline in milliseconds for fetching one sound file. */
export const soundDeadline = 8000;

const fadeSeconds = 0.6;
const bytes = new Map<string, Promise<ArrayBuffer | null>>();
const decoded = new Map<string, Promise<AudioBuffer | null>>();
let context: AudioContext | null = null;
let muted = false;
let wantedBed: { url: string; volume: number } | null = null;
let bed: {
  url: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
  started: boolean;
} | null = null;

/** Fetches sound files ahead of time so the first click plays at once. Nothing plays here. */
export function preloadSounds(urls: readonly string[]): void {
  for (const url of urls)
    if (!bytes.has(url))
      bytes.set(
        url,
        withDeadline("sound_fetch", soundDeadline, async (signal) => {
          const response = await fetch(url, { signal });
          if (!response.ok) throw new Error(`sound HTTP ${response.status}`);
          return response.arrayBuffer();
        }).catch((error: unknown) => {
          record("sound_failed", { url, message: String(error) });
          return null;
        }),
      );
}

function buffer(audio: AudioContext, url: string): Promise<AudioBuffer | null> {
  const cached = decoded.get(url);
  if (cached !== undefined) return cached;
  preloadSounds([url]);
  const promise = (bytes.get(url) ?? Promise.resolve(null)).then((data) =>
    data === null
      ? null
      : audio.decodeAudioData(data.slice(0)).catch((error: unknown) => {
          record("sound_failed", { url, message: String(error) });
          return null;
        }),
  );
  decoded.set(url, promise);
  return promise;
}

/**
 * Opens audio on the first pointer or key press anywhere, never before: browsers refuse sound
 * without a gesture, and nothing should play on load. Listens in the capture phase so a click's
 * own sound can play in the same gesture. Returns the remover.
 */
export function unlockOnGesture(): () => void {
  const unlock = () => {
    if (context === null) {
      context = new AudioContext();
      record("sound_unlocked", { state: context.state });
    }
    void context.resume();
    applyBed();
  };
  window.addEventListener("pointerdown", unlock, { capture: true });
  window.addEventListener("keydown", unlock, { capture: true });
  return () => {
    window.removeEventListener("pointerdown", unlock, { capture: true });
    window.removeEventListener("keydown", unlock, { capture: true });
  };
}

/** Plays a short sound once at `volume`, if audio is open and not muted. */
export function playOnce(url: string, volume: number): void {
  const audio = context;
  if (audio === null || muted) return;
  void buffer(audio, url).then((data) => {
    if (data === null || muted) return;
    const source = audio.createBufferSource();
    const gain = audio.createGain();
    gain.gain.value = volume;
    source.buffer = data;
    source.connect(gain).connect(audio.destination);
    source.start();
  });
}

/** Sets the looping ambient bed, or null for silence; changes fade in and out. */
export function setBed(wanted: { url: string; volume: number } | null): void {
  wantedBed = wanted;
  applyBed();
}

/** Mutes or unmutes every sound of the kit at once. */
export function setSoundMuted(value: boolean): void {
  muted = value;
  applyBed();
}

function applyBed(): void {
  const audio = context;
  if (audio === null) return;
  const target = muted ? null : wantedBed;
  if (bed !== null && (target === null || target.url !== bed.url)) {
    const leaving = bed;
    bed = null;
    leaving.gain.gain.cancelScheduledValues(audio.currentTime);
    leaving.gain.gain.setTargetAtTime(0, audio.currentTime, fadeSeconds / 3);
    if (leaving.started) leaving.source.stop(audio.currentTime + fadeSeconds * 2);
  }
  if (target === null) return;
  if (bed !== null) {
    bed.gain.gain.setTargetAtTime(target.volume, audio.currentTime, fadeSeconds / 3);
    return;
  }
  const source = audio.createBufferSource();
  const gain = audio.createGain();
  gain.gain.value = 0;
  source.loop = true;
  source.connect(gain).connect(audio.destination);
  bed = { url: target.url, source, gain, started: false };
  const starting = bed;
  void buffer(audio, target.url).then((data) => {
    if (data === null || bed !== starting) return;
    source.buffer = data;
    source.start();
    starting.started = true;
    gain.gain.setTargetAtTime(target.volume, audio.currentTime, fadeSeconds / 3);
  });
}
