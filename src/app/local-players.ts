import type { Moment } from "../moments/index.ts";
import { now, record } from "../run-log/index.ts";

export type Player = 0 | 1;

/** A local load waiting for its first painted frame to swap onto the stage. */
export interface LocalLoad {
  player: Player;
  moment: Moment;
  play: boolean;
  at: number;
}

/** What the stage's local players ask of their owner. */
export interface LocalHooks {
  /** The player on stage, or null while a session's video is. */
  onStage: () => Player | null;
  /** A load painted its first frame and its player is on stage now. */
  swapped: (load: LocalLoad, previous: Player | null) => void;
  /** The clip on stage reached its end. */
  ended: (player: Player) => void;
  /** A frame painted on a player that is on stage. */
  frame: (video: HTMLVideoElement) => void;
}

const absoluteURL = (url: string) => new URL(url, location.href).href;

/**
 * The stage's two local moment players: the next moment loads behind the one on stage and swaps in
 * at its first painted frame, so the stage never shows an empty player, and the likeliest
 * captured guess waits warmed in the player off stage.
 */
export class LocalPlayers {
  readonly videos: [HTMLVideoElement | null, HTMLVideoElement | null] = [null, null];
  readonly moments: [Moment | null, Moment | null] = [null, null];
  /** The load waiting for its first painted frame, if any. */
  load: LocalLoad | null = null;
  private attachedBoth: () => void = () => undefined;
  /** Resolves once both players are attached, so a baked opening has somewhere to play. */
  readonly attached = new Promise<void>((resolve) => {
    this.attachedBoth = resolve;
  });

  constructor(private readonly hooks: LocalHooks) {}

  private offStage(): Player {
    return this.hooks.onStage() === 0 ? 1 : 0;
  }

  /** Attaches one player and starts watching its frames and its end. */
  attach(player: Player, video: HTMLVideoElement | null): void {
    if (video === null || this.videos[player] === video) return;
    this.videos[player] = video;
    if (this.videos[0] !== null && this.videos[1] !== null) this.attachedBoth();
    const onFrame = () => {
      if (this.hooks.onStage() === player) this.hooks.frame(video);
      video.requestVideoFrameCallback(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
    video.addEventListener("ended", () => {
      if (this.hooks.onStage() === player) this.hooks.ended(player);
    });
  }

  /** The moment on stage, or null while a session's video is. */
  onStage(): Moment | null {
    const player = this.hooks.onStage();
    return player === null ? null : this.moments[player];
  }

  /** Whether the player on stage is playing now. */
  playing(): boolean {
    const player = this.hooks.onStage();
    const video = player === null ? null : this.videos[player];
    return video != null && !video.paused && !video.ended;
  }

  /** Pauses the player on stage. */
  pause(): void {
    const player = this.hooks.onStage();
    if (player !== null) this.videos[player]?.pause();
  }

  /** Plays the player on stage again when a pause stopped it partway. */
  resume(): void {
    const player = this.hooks.onStage();
    const video = player === null ? null : this.videos[player];
    if (video != null && video.paused && !video.ended && video.currentTime > 0)
      void video.play().catch((error: unknown) => {
        record("local_play_failed", { message: String(error) });
      });
  }

  /** A session's clip took the stage: the player on stage stops and any pending load is dropped. */
  leaveStage(): void {
    this.pause();
    this.load = null;
  }

  /**
   * Loads a moment's local media into the player not on stage: from its start to play it, or at
   * its last frame to hold it. It swaps onto the stage once that frame is decoded (at once for a
   * player already warmed at that frame). False when the moment has no media or no player is
   * attached.
   */
  show(moment: Moment, play: boolean): boolean {
    const url = moment.clipURL;
    const player = this.offStage();
    const video = this.videos[player];
    if (url === null || video === null) return false;
    this.moments[player] = moment;
    const load = { player, moment, play, at: now() };
    this.load = load;
    const warm = video.src === absoluteURL(url) && video.readyState >= 2;
    record(play ? "local_play" : "local_hold", {
      key: moment.key,
      clipID: moment.clipID,
      player,
      warm,
    });
    video.muted = true;
    const swap = () => {
      if (this.load !== load) return;
      this.swap(load);
      if (play)
        void video.play().catch((error: unknown) => {
          record("local_play_failed", { key: moment.key, message: String(error) });
        });
    };
    if (play && warm && video.currentTime === 0) {
      swap();
      return true;
    }
    if (video.src !== absoluteURL(url)) video.src = url;
    const seek = () => {
      if (this.load !== load) return;
      video.addEventListener("seeked", swap, { once: true });
      video.currentTime = play ? 0 : Math.max(0, video.duration - 0.04);
    };
    if (video.readyState >= 1) seek();
    else video.addEventListener("loadedmetadata", seek, { once: true });
    return true;
  }

  private swap(load: LocalLoad): void {
    this.load = null;
    const previous = this.hooks.onStage();
    if (previous !== null && previous !== load.player) this.videos[previous]?.pause();
    record("local_on_stage", {
      key: load.moment.key,
      player: load.player,
      play: load.play,
      milliseconds: Math.round((now() - load.at) * 1000),
    });
    this.hooks.swapped(load, previous);
  }

  /**
   * Keeps a moment loaded in the player not on stage, at its first frame and paused, so choosing
   * it starts at once. Never touches a player mid-load.
   */
  warm(moment: Moment | undefined): void {
    if (this.load !== null) return;
    const url = moment?.clipURL ?? null;
    const player = this.offStage();
    const video = this.videos[player];
    if (moment === undefined || url === null || video === null || video.src === absoluteURL(url))
      return;
    this.moments[player] = moment;
    video.muted = true;
    video.preload = "auto";
    video.src = url;
    video.addEventListener(
      "loadedmetadata",
      () => {
        if (video.src === absoluteURL(url)) video.currentTime = 0;
      },
      { once: true },
    );
    record("local_warm", { key: moment.key, player });
  }
}
