# Repository Guidelines

## Project Structure & Module Organization

- `src/` contains the TypeScript runtime:
  - `src/cli/` command parsing and CLI entrypoints.
  - `src/core/` execution engine, orchestration, and shared runtime types.
  - `src/resources/` built-in provisioning resources (`apt`, `file`, `directory`, `exec`, `service`).
  - `src/dashboard/` dashboard server and `src/dashboard/ui/` React + Vite frontend.
- `tests/` mirrors runtime areas (`cli`, `core`, `resources`, `output`, `integration`, `e2e`).
- `docs/` is the Next.js + Fumadocs documentation site.
- `examples/` contains runnable recipe/inventory examples.
- `scripts/` holds build/publish/sandbox utilities.

## Build, Test, and Development Commands

- `bun install` installs workspace dependencies.
- `bun run dev` runs the CLI from source (`src/cli.ts`).
- `bun run verify` runs the full local gate: typecheck, lint, format check, and tests.
- `bun run test` runs default Bun tests in `tests/`.
- `bun run test:sandbox` runs opt-in integration/e2e sandbox tests.
- `bun run dev:ui` starts dashboard development server.
- `bun run dashboard:build` builds the dashboard UI bundle.
- `bun run docs:dev` / `bun run docs:build` run and build docs.

## Coding Style & Naming Conventions

- Language: TypeScript (ESM) with Bun workspace tooling.
- Formatting is enforced by `oxfmt` (`printWidth: 100`, `semi: false`); run `bun run fmt`.
- Linting is enforced by `oxlint`; run `bun run lint`.
- Type safety is checked with `tsgo`; run `bun run typecheck`.
- Use 2-space indentation and keep filenames lowercase. Tests follow `*_test.ts`.

## Testing Guidelines

- Test framework: `bun:test`.
- Place tests in the matching domain folder under `tests/` (for example `tests/resources/file_test.ts`).
- Add or update tests with every behavior change; include integration/e2e coverage when touching execution flows.
- Before opening a PR, run `bun run verify` locally.

## Commit & Pull Request Guidelines

- Follow Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`), consistent with repository history.
- Keep commits focused and logically scoped.
- PRs should include:
  - concise problem/solution summary,
  - linked issue (if applicable),
  - commands run locally (for example `bun run verify`),
  - screenshots/GIFs for dashboard or docs UI changes.
- Ensure CI passes (`typecheck`, `lint`, `fmt:check`, `test`, dashboard build, docs build) before merge.
