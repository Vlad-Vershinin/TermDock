@AGENTS.md

# Claude Code

- Project guidance (architecture, commands, conventions, release steps) lives in `AGENTS.md`, imported above. Keep it as the single source of truth; add to it rather than duplicating here.
- Verify frontend changes with `npm run build` and backend changes with `cd src-tauri && cargo check && cargo test` before reporting them done.
