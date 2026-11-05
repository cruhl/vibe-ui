import { useState } from "react";
import { SessionsList } from "../capture/index.ts";
import {
  emptyKeys,
  forgetKeys,
  isComplete,
  saveKeys,
  savedKeys,
  useHostedPlay,
  type Keys,
  type OwnKeys,
} from "./keys.ts";

interface Props {
  /** Called with the keys once they are saved. */
  onStart: (keys: Keys) => void;
  /** Goes back to the page without saving, or null when there is nothing to go back to. */
  onClose: (() => void) | null;
}

interface FieldProps {
  label: string;
  name: keyof OwnKeys;
  keys: Keys;
  onChange: (keys: Keys) => void;
  secret?: boolean;
  hint?: string;
  link?: { href: string; text: string };
}

function Field({ label, name, keys, onChange, secret = true, hint, link }: FieldProps) {
  const [shown, setShown] = useState(false);
  const id = `key-${name}`;
  return (
    <div className="keys-field">
      <span className="keys-field-head">
        <label htmlFor={id}>{label}</label>
        {link === undefined ? null : (
          <a href={link.href} target="_blank" rel="noreferrer">
            {link.text}
          </a>
        )}
      </span>
      <span className="keys-input">
        <input
          id={id}
          name={name}
          type={secret && !shown ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          value={keys[name]}
          onChange={(event) => {
            onChange({ ...keys, [name]: event.target.value });
          }}
        />
        {secret ? (
          <button
            type="button"
            className="keys-reveal"
            aria-label={shown ? `Hide ${label}` : `Show ${label}`}
            onClick={() => {
              setShown(!shown);
            }}
          >
            {shown ? "Hide" : "Show"}
          </button>
        ) : null}
      </span>
      {hint === undefined ? null : <small>{hint}</small>}
    </div>
  );
}

/**
 * Bring your own keys: paste them once and the page runs on them instead of this site's hosted
 * play. They stay in this browser's localStorage; forgetting them goes back to hosted play.
 */
export function KeysScreen({ onStart, onClose }: Props) {
  const [keys, setKeys] = useState<Keys>(() => savedKeys() ?? emptyKeys());
  const hosted = useHostedPlay();
  const hostedOn = hosted?.hosted === true;
  const start = () => {
    saveKeys(keys);
    onStart({ ...keys, hosted: false });
  };
  const ready = keys.reactor !== "" && keys.openAI !== "" && keys.typesafe !== "";
  const saved = savedKeys();
  return (
    <main className="keys-screen">
      <header className="keys-head">
        {onClose === null ? null : (
          <button type="button" className="keys-back" onClick={onClose}>
            Back
          </button>
        )}
        <h1>Your API keys</h1>
        <p className="keys-lede">
          {hostedOn
            ? "Paste your own API keys to play on your own accounts."
            : hosted === null
              ? "Paste your API keys to play on your own accounts."
              : "The demo is off right now. Paste your API keys to play."}
        </p>
        <p className="keys-privacy">
          Keys stay in this browser. Calls go straight to each service, except TypeSafe calls, which
          pass through this site&apos;s server.
        </p>
      </header>
      <form
        className="keys-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) start();
        }}
      >
        <fieldset className="keys-group">
          <legend>Required</legend>
          <Field
            label="Reactor API key"
            name="reactor"
            keys={keys}
            onChange={setKeys}
            hint="Makes the video."
            link={{ href: "https://docs.reactor.inc", text: "Reactor docs" }}
          />
          <Field
            label="OpenAI API key"
            name="openAI"
            keys={keys}
            onChange={setKeys}
            hint="Decides what happens when you click."
            link={{ href: "https://platform.openai.com/api-keys", text: "Get a key" }}
          />
          <Field
            label="TypeSafe API key"
            name="typesafe"
            keys={keys}
            onChange={setKeys}
            hint="Finds what you can click in each frame."
            link={{ href: "https://docs.typesafe.ai", text: "TypeSafe docs" }}
          />
        </fieldset>
        <details className="keys-advanced" open={keys.fal !== ""}>
          <summary>Optional</summary>
          <Field
            label="Image key"
            name="fal"
            keys={keys}
            onChange={setKeys}
            hint="Draws art for the worlds you make and the previews while you wait."
          />
        </details>
        <div className="keys-footer">
          <p className="keys-note" data-ready={ready}>
            {ready ? "Ready." : "Add all three required keys to play."}
          </p>
          <button type="submit" className="button-primary keys-start" disabled={!ready}>
            Save and play
          </button>
          {hostedOn && saved !== null && isComplete(saved) ? (
            <button
              type="button"
              className="keys-forget"
              onClick={() => {
                forgetKeys();
                setKeys(emptyKeys());
                onClose?.();
              }}
            >
              Forget my keys
            </button>
          ) : null}
        </div>
      </form>
      <SessionsList />
    </main>
  );
}
