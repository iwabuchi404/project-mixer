# Repository Guidelines

## Project Structure & Module Organization

Project Mixer is an Electron desktop app. `main.js` owns windows, PTYs, hooks, and IPC; `preload.js` exposes the renderer bridge; `renderer.js`, `index.html`, and root CSS files implement the UI. Focused modules live under `src/`: commands, MCP transport, port discovery, file/preview safety, and phase state. Tests are in `test/`, plans in `docs/`, and README images in `screenshots/`. `dist/renderer.bundle.js` is generated—edit its sources instead.

## Build, Test, and Development Commands

- `npm install` installs dependencies; `node-pty` also requires native build tools.
- `npm run rebuild` rebuilds `node-pty` for Electron.
- `npm start` builds the renderer and launches the normal profile.
- `npm run dev:v2` runs the isolated v2 profile with renderer watching.
- `npm run build:renderer` creates the esbuild bundle.
- `npm test` runs Phase 0–4 tests; `npm run test:phase3` runs one suite.
- `npm run dist:win` (or `dist:mac`/`dist:linux`) packages into `dist/`.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, single quotes, and trailing commas in multiline structures. Follow existing formats: ESM `.js`/`.mjs` for renderer modules and CommonJS `.cjs` for Node utilities and tests. Use `camelCase` for functions/variables, `UPPER_SNAKE_CASE` for constants, and command names such as `preview_open`. No formatter or linter is configured; match nearby code.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Add cases to the matching `test/phaseN.test.cjs` suite and name them as observable outcomes. Run a focused suite while iterating, then `npm test` and `npm run build:renderer`. There is no coverage threshold; explicitly cover security boundaries, IPC/command transitions, and regressions. Electron UI behavior also requires a manual launch check.

## Commit & Pull Request Guidelines

History uses concise Conventional Commit-style subjects: `feat(v2): ...`, `fix: ...`, `docs: ...`, and `refactor(v2): ...`. Keep commits scoped and stage only intended paths; unrelated local changes may exist. PRs should explain behavior, link the relevant plan or issue, list automated/manual checks, and include screenshots for UI changes. Never commit MCP tokens or local `.project-mixer/` state.

## Agent Knowledge Workflow

Before substantial work, read `AI Cortex > projects > Project Mixer > context` in Notion and consult `spec` when relevant. Ask before recording discoveries or decisions, and update related pages together after approved specification or architecture changes.
