# Agent Notes

## Project Shape

- This is a Cloudflare Worker project.
- Main worker code lives in `src/index.ts`.
- Deployment/configuration lives in `wrangler.toml`.
- Public API behavior is documented in `README.md`; update it when changing endpoints, headers, request parameters, or response semantics.

## Development Workflow

- Use `bun` for package scripts.
- After TypeScript changes, run:
  - `bun run format`
  - `bun run lint`
- Prefer minimal changes in `src/index.ts`; keep behavior changes narrow and easy to reason about.

## Production Debugging

- Use `curl -D -` when investigating production behavior so headers are captured alongside status/body.
- When debugging endpoint behavior, compare production behavior with the corresponding implementation path in `src/index.ts`.
- If behavior depends on configuration, inspect `wrangler.toml` before assuming defaults.

## API Compatibility

- Keep response bodies stable unless the user explicitly asks for a breaking change.
- Put operational diagnostics in headers when they are not part of the public API contract.
- Update `README.md` for any public API behavior change.

## Git

- Before committing, check `git diff` and commit only relevant files.
- Use conventional commit messages, for example `fix: ...`, `feat: ...`, or `docs: ...`.
- Do NOT deploy manually. Pushes to `main` auto-deploy (GitHub Actions).
