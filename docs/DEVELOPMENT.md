# PostgreSQL MCP Server Development Guide

This file is the broad development checklist. For implementation details and security rules, see [DEVELOPER.md](DEVELOPER.md).

## Setup

```bash
npm install
npm run test:run
npm run build
```

Use Node.js 18 or newer. Tests are written with Vitest and are designed to run deterministically with one worker.

## Integration Tests

Real PostgreSQL integration tests are opt-in and require a disposable database:

```bash
POSTGRES_MCP_INTEGRATION_CONNECTION_STRING="postgresql://user:pass@localhost:5432/postgres" npm run test:integration
```

The suite creates and drops a temporary schema. Without `POSTGRES_MCP_INTEGRATION_CONNECTION_STRING`, the integration file is skipped during normal `npm run test:run` and `npm run prepublishOnly`.

GitHub Actions runs the integration suite with a PostgreSQL service on pull requests, pushes to `main`, and release publishing.

## Repository Layout

```text
src/
  index.ts              server entrypoint, CLI/config, tool registration
  integration/          opt-in real PostgreSQL integration tests
  security/             tool-call policy classification and tests
  tools/                MCP tools and focused tests
  types/                shared TypeScript types
  utils/                SQL, connection, and filesystem helpers
docs/                   published documentation
build/                  compiled package output
```

## Change Workflow

1. Inspect the existing tool and helper patterns before editing.
2. Keep new SQL behind typed schemas, identifier quoting, and bind parameters.
3. Update `src/security/policy.ts` for every new tool or operation.
4. Add focused tests beside the changed module.
5. Update [TOOL_SCHEMAS.md](../TOOL_SCHEMAS.md) and relevant docs.
6. Run verification:

```bash
npm run prepublishOnly
git diff --check
```

## Documentation Rules

Security-sensitive behavior must be documented where users are most likely to read it:

- README for defaults and operational posture.
- SECURITY for sandboxing, approvals, audit events, non-goals, and deployment posture.
- TOOL_SCHEMAS for exact tool parameters and per-tool caveats.
- docs/USAGE for common workflows.
- docs/TECHNICAL for architecture and implementation constraints.
- docs/DEVELOPER for contribution rules.

Do not document per-tool connection strings as the default path. They are disabled unless `--allow-tool-connection-string` or `POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING=true` is configured.

## Release Checklist

```bash
npm run prepublishOnly
git diff --check
npm pack --dry-run
```

`prepublishOnly` verifies tests, production dependency audit status, build outputs, built-CLI startup behavior, tool connection lifecycle cleanup, Docker runtime hardening, MCP stdio smoke behavior, docs/runtime parity, security posture documentation, package contents, and installed package/bin behavior from a generated tarball. Confirm the manual dry-run package output remains consistent with that automated package verifier.
It also runs `verify:workflows`, which checks that GitHub Actions retain least-privilege CI permissions and the PostgreSQL integration service before release publishing.
