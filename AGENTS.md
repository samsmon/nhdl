# NHDL: rules for all AI agents (Claude Code, Antigravity/Gemini, etc.)

## Documentation & record keeping
- The guide for operating the app (deploy, manage, modify, maintain, troubleshooting, and what agents must not do) is in `docs/AI_AGENT.md`. This file (AGENTS.md) only covers the rules for developing the repo.
- The full architecture map, module structure, data formats, engine events, and API contract are in `docs/ARCHITECTURE.md`. Read that file first in a new session so you do not need to re-read all the source code from scratch.
- The rework plan and task status are in `docs/PLAN.md`. Update the checklist (`[ ]`/`[~]`/`[x]`) and the Log table whenever a task is finished.
- Record every change in `docs/CHANGELOG.md` (newest entry on top, actor `AI (<agent/model>)`, e.g. `AI (Antigravity, Gemini 3.8 Flash High)`).
- If you find manual changes by the user that are not yet recorded (see `git log`), add an entry with the actor `Manual (<name>)`.
- In documentation, call the target site "certain site ( ͡° ͜ʖ ͡°)" and use `certain.site` as the example domain. The real name may only appear in code.

## Git
- Commits and pushes **must be made as the user** (identity from `git config user.name` / `user.email`). Do not change the git identity, do not use another author, and do not add a `Co-Authored-By` trailer or any AI attribution to commit messages or PR descriptions.
- Rework (Phase 1 onward) happens on the `rework` branch. `main` only accepts changes that are already stable.
- Run `npm test` before committing (once tests exist in Phase 1). Do not commit if tests fail.

## Architecture
- There is no CLI; the only entry point is `server/index.js`.
- All state (queue, library, config, logs) lives in the database through `core/db.js` (async): SQLite `data/nhdl.db` by default, or PostgreSQL when `DATABASE_URL` is set. Do not store state in new text/JSON files. Exception: secrets stay in `.env`.
- Pattern for every new feature (e.g. per-item Pause/Resume):
  1. State is stored in a DB table. New columns/tables go through schema migrations in **both** adapters (`core/db/sqlite.js` and `core/db/postgres.js`), then are exposed through `core/db.js`.
  2. Changes are made through REST endpoints documented in `docs/API.md`.
  3. The UI receives changes through SSE events (`/api/events`), **not** polling.
- Every new endpoint or event must be added to `docs/API.md` first, then implemented.
