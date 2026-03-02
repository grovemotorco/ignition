# Bun Test Suite (`tests-bun/`)

This directory contains Bun-migrated duplicates of the legacy Deno tests in
`tests/`.

## Layout

- `tests/`: Original Deno tests kept as reference.
- `tests-bun/`: Bun-compatible copies used by `bun run test`.
- `tests-bun/helpers/`: Shared helpers used by migrated tests.

## Running

```bash
# Default Bun suite
bun run test

# Enable sandbox integration + e2e tests
IGNITION_RUN_SANDBOX_TESTS=1 DENO_DEPLOY_TOKEN=... bun run test
```

## Notes

- Sandbox tests are intentionally skipped unless both token and opt-in flag are set.
