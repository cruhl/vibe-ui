/** The names of the drawn control icons. */
export type IconName =
  | "play"
  | "pause"
  | "restart"
  | "end"
  | "message"
  | "worlds"
  | "sound"
  | "muted"
  | "send"
  | "keys"
  | "make"
  | "link";

const paths: Record<IconName, string> = {
  play: "M7 4.5v15l12-7.5z",
  pause: "M8 5v14M16 5v14",
  restart: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4",
  end: "M12 3.5v8M7.2 6.6a7.5 7.5 0 1 0 9.6 0",
  message:
    "M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17H10l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z",
  worlds: "M4.5 4.5h6v6h-6zM13.5 4.5h6v6h-6zM4.5 13.5h6v6h-6zM13.5 13.5h6v6h-6z",
  sound: "M4.5 9.5h3l5-4v13l-5-4h-3zM16 9a4 4 0 0 1 0 6M18.5 6.5a7.5 7.5 0 0 1 0 11",
  muted: "M4.5 9.5h3l5-4v13l-5-4h-3zM16.5 9.5l5 5M21.5 9.5l-5 5",
  send: "M4.5 12h14M13 6.5l5.5 5.5-5.5 5.5",
  keys: "M14.5 9.5a4 4 0 1 1-1.2-2.8M13.3 6.7l6.2 6.2M17 10.5l2-2M15 12.5l2 2",
  make: "M12 4.5l1.9 5.6 5.6 1.9-5.6 1.9-1.9 5.6-1.9-5.6-5.6-1.9 5.6-1.9zM18.5 3.5v3M17 5h3",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
};

/** One drawn stroke icon, 18 px, in the current text color. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      aria-hidden="true"
      fill={name === "play" ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
