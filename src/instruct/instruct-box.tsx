import { useState } from "react";

interface Props {
  enabled: boolean;
  onSend: (text: string) => void;
}

/**
 * Tells the agent directly what the world should do ("open a cave painting app", "make it
 * rain"). The field grows with the message so all of it stays readable; Enter sends and clears,
 * Shift+Enter breaks a line. The controller treats it as an input that interrupts guesses.
 */
export function InstructBox({ enabled, onSend }: Props) {
  const [text, setText] = useState("");
  const send = () => {
    if (text.trim() === "") return;
    onSend(text.trim());
    setText("");
  };
  return (
    <form
      className="instruct-box"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <textarea
        aria-label="Tell the world what to do"
        placeholder="Tell the world what to do"
        enterKeyHint="send"
        rows={1}
        autoFocus
        value={text}
        disabled={!enabled}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
          event.preventDefault();
          send();
        }}
      />
      <button type="submit" disabled={!enabled || text.trim() === ""}>
        Send
      </button>
    </form>
  );
}
