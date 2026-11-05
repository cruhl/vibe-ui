import { useEffect, useRef } from "react";

interface Props {
  active: boolean;
  muted: boolean;
  onVideo: (video: HTMLVideoElement | null) => void;
}

/**
 * The stage's local player: a plain video element over a moment's own media, captured from the
 * step results or baked. It sits with the sessions' players and shows whenever a moment plays or
 * holds from local media, so a chosen moment needs no network to start.
 */
export function MomentPlayer({ active, muted, onVideo }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    onVideo(video);
    if (video !== null) video.muted = muted || !active;
  }, [active, muted, onVideo]);
  return (
    <video
      ref={videoRef}
      className="omni-video"
      data-active={active}
      data-visible={active}
      data-player="moment"
      muted
      playsInline
      preload="auto"
    />
  );
}
