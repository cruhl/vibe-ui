import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { Capture, type Fixture } from "../src/eval/capture.ts";
import { parseEvalCase } from "../src/eval/case.ts";

const usage = `pnpm eval:fixture <evalID> <name>

Turns a finished eval with a real agent (.agent/evals/<evalID>/run.jsonl) into a replay:
src/eval/replays/<name>.json holds every captured agent reply with its content-time offsets (the
fetch shim's captures, else the app's own agent_turn records), and
src/eval/cases/<name>.md is the source case as a scripted user that repeats the accepted
actions in order, with "replay" set to <name>. Run it with --agent=replay for a run that costs no
tokens and no GPU.`;

const [evalID, name] = process.argv.slice(2);
if (evalID === undefined || name === undefined || evalID === "--help") {
  process.stdout.write(`${usage}\n`);
  process.exit(evalID === "--help" ? 0 : 1);
}
if (!/^[a-z0-9-]+$/.test(name))
  throw new Error("the fixture name must be lowercase words and dashes");

const root = join(import.meta.dirname, "..");
const Event = z.looseObject({ kind: z.string() });
const events = readFileSync(join(root, ".agent", "evals", evalID, "run.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => Event.parse(JSON.parse(line)));
const shimmed = events.flatMap((event) =>
  event.kind === "agent_capture" ? [Capture.parse(event.capture)] : [],
);
const captures =
  shimmed.length > 0
    ? shimmed
    : events.flatMap((event) => {
        if (event.kind !== "agent_turn") return [];
        const turn = Capture.safeParse(event);
        return turn.success ? [turn.data] : [];
      });
if (captures.length === 0)
  throw new Error("the run has no agent captures; run it with --agent=real");
const start = z
  .object({ caseName: z.string() })
  .parse(events.find((event) => event.kind === "eval_start"));
const Action = z.object({
  accepted: z.boolean(),
  action: z.string(),
  intent: z.string(),
  landedElementID: z.string().nullable(),
  point: z.object({ x: z.number(), y: z.number() }),
});
const script = events.flatMap((event) => {
  if (event.kind !== "eval_action") return [];
  const action = Action.parse(event);
  if (!action.accepted || action.landedElementID === null) return [];
  return [{ action: "click", elementID: action.landedElementID, intent: action.intent }];
});
const fixture: Fixture = { source: evalID, captures };
mkdirSync(join(root, "src", "eval", "replays"), { recursive: true });
writeFileSync(join(root, "src", "eval", "replays", `${name}.json`), `${JSON.stringify(fixture)}\n`);
const sourceText = readFileSync(join(root, "src", "eval", "cases", `${start.caseName}.md`), "utf8");
const source = parseEvalCase(start.caseName, sourceText);
const { name: _name, persona, ...config } = source;
const evalCase = { ...config, user: "scripted", script, replay: name };
writeFileSync(
  join(root, "src", "eval", "cases", `${name}.md`),
  `\`\`\`json\n${JSON.stringify(evalCase, null, 2)}\n\`\`\`\n\n${persona}\n`,
);
execFileSync(join(root, "node_modules", ".bin", "prettier"), [
  "--write",
  join(root, "src", "eval", "replays", `${name}.json`),
  join(root, "src", "eval", "cases", `${name}.md`),
]);
process.stdout.write(
  `${captures.length} captures, ${script.length} scripted steps: src/eval/replays/${name}.json, src/eval/cases/${name}.md\n`,
);
