import { useEffect, useRef } from "react";

interface Props {
  stream: MediaStream;
  trackCount: number;
  active: boolean;
  /** Whether this picture is on screen; it can trail `active` until the new slot has painted. */
  visible: boolean;
  /** Whether this picture stays painted under a newly shown one while that one composites. */
  under?: boolean;
  muted: boolean;
  onVideo: (video: HTMLVideoElement | null) => void;
}

/**
 * One session's live video. Every session of the pool keeps playing and holding its last frame;
 * only the active one is visible and audible, so switching is instant.
 */
export function OmniPlayer({
  stream,
  trackCount,
  active,
  visible,
  under = false,
  muted,
  onVideo,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const attached = useRef<MediaStream | null>(null);
  useEffect(() => {
    const video = videoRef.current;
    onVideo(video);
    if (video === null) return;
    if (attached.current !== stream) {
      attached.current = stream;
      video.srcObject = stream;
    }
    video.muted = muted || !active;
    if (trackCount > 0) void video.play().catch(() => undefined);
  }, [stream, trackCount, active, muted, onVideo]);
  return (
    <video
      ref={videoRef}
      className="omni-video"
      data-active={active}
      data-visible={visible}
      data-under={under}
      autoPlay
      muted
      playsInline
    />
  );
}
