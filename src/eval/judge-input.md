# Judge input phrasing

What the judge reads beside the recording. Each line is `key: text`; `{name}` is filled by `scripts/eval-judge.ts`, and `{newline}` breaks a line.

input: Eval case: {caseName}{newline}{newline}Persona and goal:{newline}{persona}{newline}{newline}Timeline (seconds into the recording):{newline}{timeline}
refused: {at}s action not taken by the app: aimed at {intended} ({intent}), landed on {landed}
action: {at}s action {index}: {action}, meant {intended} ({intent}), hit {landed}{during}
during: , while a clip played
clip: {at}s clip starts, prompt: {prompt}
state: {at}s agent's intended state: {scene} Clickable: {elements}
end: {at}s session ends
