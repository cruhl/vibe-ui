import { useEffect, useState } from "react";
import { useCurrentKeys, useHostedPlay } from "../keys/index.ts";
import { getBusyKit, openingStillKey } from "../liveness/index.ts";
import { downloadScenarioFolder, useScenarios, type Scenario } from "../scenario/index.ts";
import { keysURL } from "../route/index.ts";
import { get } from "../storage/index.ts";
import { CreateForm, shareLabels, useShare } from "./create.tsx";
import { Icon } from "./icon.tsx";

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

/** How many cards, in reading order, load their picture at once; the rest wait for the scroll. */
const eagerCards = 6;

const cardSizes =
  "(max-width: 640px) 88px, (max-width: 960px) 50vw, (max-width: 1360px) 33vw, 310px";

const canPreview = () =>
  matchMedia("(hover: hover)").matches && !matchMedia("(prefers-reduced-motion: reduce)").matches;

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
 * A card's picture: the baked opening's held frame (with its silent loop while pointed at or
 * focused), else the opening still this browser kept, else a quiet field in the world's accent.
 */
function CardArt({
  scenario,
  still,
  accent,
  order,
  previewing,
}: {
  scenario: Scenario;
  still: string | undefined;
  accent: string | null;
  order: number;
  previewing: boolean;
}) {
  const card = scenario.card;
  const loop = previewing ? (card?.loopURL ?? null) : null;
  const smallest = card?.images[0];
  return (
    <span
      className="picker-still"
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
          sizes={cardSizes}
          width={1344}
          height={768}
          loading={order < eagerCards ? "eager" : "lazy"}
          fetchPriority={order < 3 ? "high" : "auto"}
          decoding="async"
          alt=""
        />
      ) : still !== undefined ? (
        <img src={still} width={1344} height={768} decoding="async" alt="" />
      ) : null}
      {loop === null ? null : <Loop url={loop} />}
    </span>
  );
}

function Card({
  scenario,
  still,
  current,
  order,
  onChoose,
}: {
  scenario: Scenario;
  still: string | undefined;
  current: boolean;
  order: number;
  onChoose: (scenarioID: string) => void;
}) {
  const loaded = getBusyKit(scenario.id);
  const [shareState, share] = useShare(scenario.id);
  const [previewing, setPreviewing] = useState(false);
  const start = () => {
    if (scenario.card?.loopURL != null && canPreview()) setPreviewing(true);
  };
  const stop = () => {
    setPreviewing(false);
  };
  return (
    <div
      className="picker-card"
      data-current={current}
      data-scenario={scenario.id}
      onPointerEnter={start}
      onPointerLeave={stop}
      onFocus={start}
      onBlur={stop}
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
          previewing={previewing}
        />
        <span className="picker-name">{scenario.name}</span>
        <span className="picker-pitch">{loaded?.kit.pitch ?? scenario.idea ?? ""}</span>
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
 * The world picker and home screen: the create flow's idea box first, then every world (the
 * folders and the ones this browser wrote) with its name, pitch and a picture of its opening. Choosing or writing one ends any running session first.
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
  const endedName = scenarios.find((scenario) => scenario.id === endedScenarioID)?.name ?? null;
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
  return (
    <div className="picker" data-testid="scenario-picker" role="dialog" aria-label="Choose a world">
      {keys === null ? (
        <p className="picker-off" role="status">
          {hosted === null ? "" : "The demo is off right now. "}
          <a href={keysURL()}>Add your API keys</a> to play or make a world.
        </p>
      ) : null}
      {endedName === null ? null : (
        <p className="picker-ended" role="status">
          {endedName} ended. Play it again or pick another.
        </p>
      )}
      <CreateForm
        onWrite={onWrite}
        focus={focusCreate}
        actions={
          canShutDown || onClose !== null ? (
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
          ) : null
        }
      />
      <h2 className="picker-section">{heading}</h2>
      <div className="picker-grid">
        {scenarios.map((scenario, order) => (
          <Card
            key={scenario.id}
            scenario={scenario}
            still={stills[scenario.id]}
            current={scenario.id === currentScenarioID}
            order={order}
            onChoose={onChoose}
          />
        ))}
      </div>
      <KeysLine />
    </div>
  );
}
