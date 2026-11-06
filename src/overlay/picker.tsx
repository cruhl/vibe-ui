import { useEffect, useState } from "react";
import { useCurrentKeys, useHostedPlay } from "../keys/index.ts";
import { getBusyKit, openingStillKey } from "../liveness/index.ts";
import { downloadScenarioFolder, useScenarios, type Scenario } from "../scenario/index.ts";
import { keysURL } from "../route/index.ts";
import { get } from "../storage/index.ts";
import { CreateForm, shareLabels, useShare } from "./create.tsx";
import { Icon } from "./icon.tsx";
import { PoweredBy } from "./powered-by.tsx";

interface Props {
  heading: string;
  currentScenarioID: string | null;
  /** The world the person just ended, for a line saying so. */
  endedScenarioID?: string | null;
  canShutDown: boolean;
  onChoose: (scenarioID: string) => void;
  onWrite: (idea: string) => void;
  onShutDown: () => void;
  onClose: (() => void) | null;
  /** Whether the idea box takes the focus when the picker opens. */
  focusCreate?: boolean;
}

function useOpeningStills(scenarios: readonly Scenario[]): Record<string, string> {
  const [stills, setStills] = useState<Record<string, string>>({});
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      scenarios.map(async (scenario) => {
        const still = await get("frames", openingStillKey(scenario.id));
        return typeof still === "string" ? ([scenario.id, still] as const) : null;
      }),
    ).then((found) => {
      if (!cancelled) setStills(Object.fromEntries(found.filter((entry) => entry !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [scenarios]);
  return stills;
}

/**
 * How big a card is on the wall: the featured first world, the two large screens after it, then
 * every other world.
 */
type CardSize = "feature" | "large" | "small";

const cardSizes: Record<CardSize, string> = {
  feature: "(max-width: 1099px) 100vw, 70vw",
  large: "(max-width: 639px) 100vw, 50vw",
  small: "(max-width: 639px) 100vw, (max-width: 1099px) 50vw, 33vw",
};

/** How many cards, in reading order, load their picture at once; the rest wait for the scroll. */
const eagerCards = 3;

const largeCards = 2;

const motionAllowed = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;

const canHover = () => matchMedia("(hover: hover)").matches;

/**
 * Whether the element is on screen, watched only while `enabled`: the whole viewport for the
 * featured card, a band across the middle of the screen for cards on a touch screen, so the one
 * the person has scrolled to plays.
 */
function useOnScreen(enabled: boolean, band: boolean): [(node: Element | null) => void, boolean] {
  const [node, setNode] = useState<Element | null>(null);
  const [onScreen, setOnScreen] = useState(false);
  useEffect(() => {
    if (!enabled || node === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        setOnScreen(entries.some((entry) => entry.isIntersecting));
      },
      band ? { rootMargin: "-45% 0px -45% 0px" } : { threshold: 0.3 },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [enabled, band, node]);
  return [setNode, enabled && onScreen];
}

/** The opening's silent loop over a card's picture, shown once it is really playing. */
function Loop({ url }: { url: string }) {
  const [playing, setPlaying] = useState(false);
  return (
    <video
      className="picker-loop"
      data-playing={playing}
      src={url}
      muted
      loop
      autoPlay
      playsInline
      disablePictureInPicture
      aria-hidden="true"
      onPlaying={() => {
        setPlaying(true);
      }}
    />
  );
}

/**
 * A card's picture: the baked opening's held frame (with its silent loop while it plays), else
 * the opening still this browser kept, else a quiet field in the world's accent.
 */
function CardArt({
  scenario,
  still,
  accent,
  order,
  size,
  playing,
}: {
  scenario: Scenario;
  still: string | undefined;
  accent: string | null;
  order: number;
  size: CardSize;
  playing: boolean;
}) {
  const card = scenario.card;
  const loop = playing ? (card?.loopURL ?? null) : null;
  const smallest = card?.images[0];
  return (
    <span
      className="picker-frame"
      data-art={smallest !== undefined ? "opening" : still !== undefined ? "still" : "empty"}
      ref={(node) => {
        if (accent === null) node?.style.removeProperty("--picker-accent");
        else node?.style.setProperty("--picker-accent", accent);
      }}
    >
      {card !== null && smallest !== undefined ? (
        <img
          src={smallest.url}
          srcSet={card.images.map((image) => `${image.url} ${String(image.width)}w`).join(", ")}
          sizes={cardSizes[size]}
          width={1344}
          height={768}
          loading={order < eagerCards ? "eager" : "lazy"}
          fetchPriority={order === 0 ? "high" : "auto"}
          decoding="async"
          alt=""
        />
      ) : still !== undefined ? (
        <img src={still} width={1344} height={768} decoding="async" alt="" />
      ) : null}
      {loop === null ? null : <Loop url={loop} />}
      {size === "feature" ? null : (
        <span className="picker-cue" aria-hidden="true">
          <Icon name="play" />
          Play
        </span>
      )}
    </span>
  );
}

function Card({
  scenario,
  still,
  current,
  playingNow,
  order,
  size,
  onChoose,
}: {
  scenario: Scenario;
  still: string | undefined;
  current: boolean;
  /** Whether this is the world on stage behind the picker. */
  playingNow: boolean;
  order: number;
  size: CardSize;
  onChoose: (scenarioID: string) => void;
}) {
  const loaded = getBusyKit(scenario.id);
  const [shareState, share] = useShare(scenario.id);
  const [pointed, setPointed] = useState(false);
  const loopable = scenario.card?.loopURL != null && motionAllowed();
  const feature = size === "feature";
  const [watch, onScreen] = useOnScreen(loopable && (feature || !canHover()), !feature);
  const point = () => {
    if (loopable && canHover()) setPointed(true);
  };
  const leave = () => {
    setPointed(false);
  };
  return (
    <div
      className="picker-card"
      data-size={size}
      data-current={current}
      data-scenario={scenario.id}
      ref={watch}
      onPointerEnter={point}
      onPointerLeave={leave}
      onFocus={() => {
        if (loopable) setPointed(true);
      }}
      onBlur={leave}
    >
      <button
        type="button"
        className="picker-open"
        onClick={() => {
          onChoose(scenario.id);
        }}
      >
        <CardArt
          scenario={scenario}
          still={still}
          accent={loaded?.kit.colors.accent ?? null}
          order={order}
          size={size}
          playing={pointed || onScreen}
        />
        <span className="picker-caption">
          {playingNow ? <span className="picker-now">Now playing</span> : null}
          <span className="picker-name">{scenario.name}</span>
          <span className="picker-pitch">{loaded?.kit.pitch ?? scenario.idea ?? ""}</span>
          {feature ? (
            <span className="picker-play">
              <Icon name="play" />
              Play
            </span>
          ) : null}
        </span>
      </button>
      {scenario.origin === "written" ? (
        <span className="picker-card-actions">
          <button type="button" disabled={shareState === "sharing"} onClick={share}>
            <Icon name="link" />
            {shareLabels[shareState]}
          </button>
          <button
            type="button"
            onClick={() => {
              void downloadScenarioFolder(scenario.id);
            }}
          >
            Export
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** The quiet line at the foot of the picker: how this page is running, and the way to change it. */
function KeysLine() {
  const keys = useCurrentKeys();
  const hosted = useHostedPlay();
  if (keys?.hosted === true)
    return (
      <p className="picker-keys-line">
        <a href={keysURL()}>Use your own API keys</a>
      </p>
    );
  if (keys !== null)
    return (
      <p className="picker-keys-line">
        Using your API keys. <a href={keysURL()}>Change</a>
      </p>
    );
  return (
    <p className="picker-keys-line">
      {hosted === null ? "" : "The demo is off right now. "}
      <a href={keysURL()}>Add your API keys</a> to play.
    </p>
  );
}

/**
 * The world picker and home screen: the product's name, the first world in picker order playing
 * large beside the create flow's idea box, then a wall of every other world (the folders and the
 * ones this browser wrote) with its name, pitch and a picture of its opening that plays while
 * pointed at. Choosing or writing one ends any running session first.
 */
export function ScenarioPicker({
  heading,
  currentScenarioID,
  endedScenarioID = null,
  canShutDown,
  onChoose,
  onWrite,
  onShutDown,
  onClose,
  focusCreate = false,
}: Props) {
  const scenarios = useScenarios();
  const ended = scenarios.find((scenario) => scenario.id === endedScenarioID) ?? null;
  const stills = useOpeningStills(scenarios);
  const keys = useCurrentKeys();
  const hosted = useHostedPlay();
  useEffect(() => {
    if (onClose === null) return;
    const close = onClose;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const [featured, ...rest] = scenarios;
  const card = (scenario: Scenario, order: number, size: CardSize) => (
    <Card
      key={scenario.id}
      scenario={scenario}
      still={stills[scenario.id]}
      current={scenario.id === currentScenarioID}
      playingNow={canShutDown && scenario.id === currentScenarioID}
      order={order}
      size={size}
      onChoose={onChoose}
    />
  );
  return (
    <div className="picker" data-testid="scenario-picker" role="dialog" aria-label="Choose a world">
      <header className="picker-top">
        <div className="picker-brand">
          <h1 className="picker-wordmark">vibe-ui</h1>
          <p className="picker-tagline">
            Play inside a video. Click anything, and it films what happens next.
          </p>
        </div>
        <div className="picker-top-end">
          {canShutDown || onClose !== null ? (
            <div className="picker-actions">
              {canShutDown ? (
                <button type="button" className="picker-shutdown" onClick={onShutDown}>
                  Stop playing
                </button>
              ) : null}
              {onClose === null ? null : (
                <button type="button" onClick={onClose}>
                  Back
                </button>
              )}
            </div>
          ) : null}
          <PoweredBy placement="inline" />
        </div>
      </header>
      {keys === null ? (
        <p className="picker-off" role="status">
          {hosted === null ? "" : "The demo is off right now. "}
          <a href={keysURL()}>Add your API keys</a> to play or make a world.
        </p>
      ) : null}
      {ended === null ? null : (
        <p className="picker-ended" role="status">
          <span>
            {ended.name} ended.{" "}
            <button
              type="button"
              className="picker-again"
              onClick={() => {
                onChoose(ended.id);
              }}
            >
              Play it again
            </button>{" "}
            or pick another.
          </span>
        </p>
      )}
      <div className="picker-stage">
        {featured === undefined ? null : card(featured, 0, "feature")}
        <CreateForm onWrite={onWrite} focus={focusCreate} />
      </div>
      <h2 className="picker-section">{heading}</h2>
      <div className="picker-grid">
        {rest.map((scenario, index) =>
          card(scenario, index + 1, index < largeCards ? "large" : "small"),
        )}
      </div>
      <footer className="picker-foot">
        <KeysLine />
      </footer>
    </div>
  );
}
