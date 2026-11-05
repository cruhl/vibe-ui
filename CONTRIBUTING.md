# Contributing

Start with the quick start in the [README](README.md).

## The gate

`pnpm check` runs types, lint, format, tests, a production build and the bundle scan. Every commit passes it. The code rules live in [AGENTS.md](AGENTS.md).

## Proof

Show a change to the live loop working.

- Run an eval (`pnpm eval --help`), mocked where the change allows, and paste its summary line into the pull request.
- If the change needs real sessions, `pnpm scenario-drive --help` drives a world end to end and saves a frame per step.
- For a visual change, attach stills or a recording from `pnpm record-ui --help` at the wide and the narrow viewport.

Real sessions bill your own accounts. Mocked Omni and Jev are free; the world agent still calls OpenAI.

## Worlds

A world is a folder under `src/presets/`. Adding one takes no code. Don't commit `moments/`; bake it locally (`pnpm bake --help`).

## Pull requests

One change per pull request, titled with what changed. Keep the tree compiling at every commit. Add dependencies with `pnpm add` at an exact version, then run `pnpm audit`.
