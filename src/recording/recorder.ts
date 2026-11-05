import { appendFile } from "../capture/index.ts";
import { frameSize } from "../omni/index.ts";
import { record } from "../run-log/index.ts";

const { width, height } = frameSize;
const sliceMs = 2000;

/** What the recorder needs from the stage: the video on screen and every session's stream. */
export interface RecordingSource {
  activeVideo: () => HTMLVideoElement | null;
  activeIndex: () => number;
  streams: () => MediaStream[];
}

/**
 * Records what the person sees and hears from the start of the session: every frame of whichever
 * pool session is on screen, drawn to one canvas, with that session's audio. Two-second slices are
 * appended to the session bundle as they arrive, so a reload loses at most one slice.
 */
export class Recorder {
  private recorder: MediaRecorder | null = null;
  private frame = 0;
  private audio: AudioContext | null = null;
  private readonly gains = new Map<MediaStream, GainNode>();
  private bytes = 0;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private startedAt: number | null = null;

  /** Seconds since the recording began, so a run-log time maps onto the recording. */
  private seconds(): number | null {
    return this.startedAt === null
      ? null
      : Math.round((performance.now() - this.startedAt) / 10) / 100;
  }

  constructor(private readonly source: RecordingSource) {}

  start(): void {
    if (this.recorder !== null || typeof MediaRecorder === "undefined") return;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (context === null) return;
    let painted = false;
    const draw = () => {
      const video = this.source.activeVideo();
      if (video !== null && video.videoWidth > 0) {
        context.drawImage(video, 0, 0, width, height);
        if (!painted) {
          painted = true;
          record("recording_first_frame", { recordingSeconds: this.seconds() });
        }
      }
      this.connectAudio();
      this.frame = requestAnimationFrame(draw);
    };
    draw();
    this.audio = new AudioContext();
    const destination = this.audio.createMediaStreamDestination();
    this.destination = destination;
    const tracks = [
      ...canvas.captureStream(30).getVideoTracks(),
      ...destination.stream.getAudioTracks(),
    ];
    const mimeType = ["video/webm;codecs=vp8,opus", "video/webm"].find((type) =>
      MediaRecorder.isTypeSupported(type),
    );
    const recorder = new MediaRecorder(
      new MediaStream(tracks),
      mimeType === undefined ? {} : { mimeType },
    );
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return;
      this.bytes += event.data.size;
      appendFile("recording.webm", event.data);
    };
    recorder.onerror = () => {
      record("recording_failed", {});
    };
    recorder.start(sliceMs);
    this.startedAt = performance.now();
    this.recorder = recorder;
    record("recording_started", { mimeType: recorder.mimeType, audio: this.audio.state });
  }

  private connectAudio(): void {
    const audio = this.audio;
    const destination = this.destination;
    if (audio === null || destination === null) return;
    const streams = this.source.streams();
    streams.forEach((stream, index) => {
      let gain = this.gains.get(stream);
      if (gain === undefined && stream.getAudioTracks().length > 0) {
        gain = audio.createGain();
        audio.createMediaStreamSource(stream).connect(gain).connect(destination);
        this.gains.set(stream, gain);
      }
      if (gain !== undefined) gain.gain.value = index === this.source.activeIndex() ? 1 : 0;
    });
  }

  /** Lets audio into the recording once the page has had a gesture. */
  resume(): void {
    if (this.audio?.state === "suspended") void this.audio.resume();
  }

  /** Stops recording; the last slice is appended before the promise resolves. */
  stop(): Promise<void> {
    const recorder = this.recorder;
    cancelAnimationFrame(this.frame);
    if (recorder === null || recorder.state === "inactive") return Promise.resolve();
    return new Promise((resolve) => {
      recorder.addEventListener(
        "stop",
        () => {
          record("recording_stopped", { bytes: this.bytes });
          void this.audio?.close();
          resolve();
        },
        { once: true },
      );
      recorder.stop();
    });
  }
}
