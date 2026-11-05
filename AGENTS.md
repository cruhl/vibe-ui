# AGENTS.md

Notes for coding agents. The folder tree, each domain's `index.ts` and doc comments, and every script's `--help` are the spec; this file holds only what no tool checks.

## Shape

- Each folder under `src/` is a domain, imported from elsewhere only through its `index.ts` (lint enforces it). `src/app` composes the domains and hands each one what it reads through props or arguments; `src/route` is the one reader and writer of the URL.
- Every sentence a model reads lives in a `.md` file beside the code that sends it; code fills named `{slots}` and never writes prose.
- Every provider call goes from the browser: straight to the provider with the visitor's own key, or in hosted play through the Worker's `/api` routes (`deploy/`), which hold the keys; `src/keys` decides which, and no key of the deployment ever reaches the page. Dev-only helpers live in `dev/` and never reach the production bundle; `pnpm check` scans the build for `.env.local` values. `.env.example` names every key.

## Omni contract

- Clips are only 5.875, 8, 10.125, 12.25 or 14.375 seconds. Flush on clip end and autoplay are off; clips play by id.
- A continuation source must already be built. A keyframe needs a reference image.
- Every session ends with a non-recoverable disconnect on every exit path.

## Code

- TypeScript strict: no `as` except `as const`, no `!`. Zod at every JSON, fetch and message boundary.
- Full-word names, abbreviations uppercase (`getModelID`), no single-letter names except `i`, `j`, `x`, `y`, `z`, `t`. No inline comments; doc comments on public APIs only. Single-line ifs without braces. No em dashes in prose or prompts.
- Dependencies are pinned exact; add them with `pnpm add`, never `npx` or `pnpm dlx`, and run `pnpm audit`.
- `pnpm check` passes before every commit.

## Proof

- The run log stamps every event on one session clock; it is for diagnosis, never a channel between domains. `window.vibeUI` is the controller, published for drivers outside the page; no module reads it.
- Hosted play's routes need a Turnstile pass, which an automated browser does not earn: scripts drive the dev server on own keys from `.env.local`, which never touches a hosted route. A headless check of the deployed page passes only with a stock Chrome user agent and `--disable-blink-features=AutomationControlled`.
- `pnpm scenario-drive --help` drives any world end to end on real sessions; `pnpm bake --help` grows and saves a preset's moments. Scripts start servers, browsers and the Reactor backstop through `scripts/plumbing.ts`.
