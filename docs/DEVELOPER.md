# PostgreSQL MCP Server Developer Guide

This guide is for contributors changing the server. For end-user tool parameters, use [TOOL_SCHEMAS.md](../TOOL_SCHEMAS.md).

## Local Setup

```bash
npm install
npm run build
npm run test:run
```

The deterministic test command is:

```bash
npx vitest run --pool=threads --maxWorkers=1 --minWorkers=1
```

Use the same command before publishing or making security-sensitive changes.

## Current Project Shape

```text
src/
  index.ts              MCP server, CLI/config loading, security policy enforcement
  server/boundary.ts    request boundary helpers for connection string handling
  security/policy.ts    centralized tool-call risk classification
  tools/                individual MCP tools and focused unit tests
  types/tool.ts         shared tool types
  utils/connection.ts   PostgreSQL pool wrapper, timeouts, error sanitization
  utils/filesystem.ts   workspace path and file-size sandbox helpers
  utils/sql.ts          identifier quoting, predicates, redaction, read-only validation
```

The public runtime is built into `build/`. Source tests live beside implementation files as `*.test.ts`.

## Security Rules For New Work

Start with the security boundary, not the SQL string.

- Add every new tool or new operation to `src/security/policy.ts`.
- Default new functionality to `read` or the narrowest applicable risk.
- Treat arbitrary SQL fragments, executable database code, column defaults, RLS predicates, CHECK expressions, trigger `WHEN` expressions, and raw filters as `arbitrary_sql`.
- Require explicit structured inputs whenever possible.
- Quote identifiers with `quoteIdent` or `quoteQualifiedIdent`.
- Parameterize values. Do not interpolate untrusted values into SQL.
- Use `buildWhereClause` for DML predicates and `buildStaticWhereClause` only where PostgreSQL syntax does not allow bind parameters.
- Reject legacy string predicates unless the field is explicitly named `rawWhere`.
- Sanitize returned errors with `sanitizeErrorMessage`.
- Redact catalog SQL text with `redactSqlText` unless returning user data is the purpose of the tool.
- Keep filesystem reads/writes inside `POSTGRES_MCP_WORKSPACE_DIR` or `--workspace-dir`.

## Adding A Tool Or Operation

1. Define a strict Zod schema near the tool implementation.
2. Validate input before resolving a connection string.
3. Add policy classification tests in `src/security/policy.test.ts`.
4. Add focused tool tests for SQL construction, policy-sensitive input rejection, redaction, and error sanitization.
5. Update [TOOL_SCHEMAS.md](../TOOL_SCHEMAS.md) and user-facing docs.
6. Run `npm run prepublishOnly` and `git diff --check`.

Minimal tool pattern:

```ts
const InputSchema = z.object({
  operation: z.enum(['get']),
  schema: z.string().optional().default('public')
});

export const exampleTool: PostgresTool = {
  name: 'pg_example',
  description: 'Example read-only tool',
  inputSchema: InputSchema,
  async execute(args, getConnectionString) {
    const parsed = InputSchema.safeParse(args);
    if (!parsed.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${parsed.error.message}` }], isError: true };
    }

    const db = DatabaseConnection.getInstance();

    try {
      await db.connect(getConnectionString(undefined));
      const rows = await db.query('SELECT 1 AS ok');
      return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: sanitizeErrorMessage(error) }], isError: true };
    } finally {
      await db.disconnect();
    }
  }
};
```

## Testing Expectations

Use small unit tests with mocked `DatabaseConnection` for most behavior. Security-sensitive tests should prove both the generated SQL and that rejected input does not call `connect` or `query`.

Cover these cases when relevant:

- invalid identifiers
- structured predicate SQL and values
- rejection of legacy raw strings
- output caps
- timeout propagation
- redaction of database errors and catalog SQL
- policy classification and denial behavior

## Release Checklist

Before publishing:

```bash
npm run prepublishOnly
git diff --check
npm pack --dry-run
```

`prepublishOnly` runs the deterministic test suite, production dependency audit verifier, build verifier, built-CLI startup verifier, tool connection lifecycle verifier and self-test, docs/runtime parity verifier, security posture docs verifier, Docker runtime verifier, MCP stdio smoke verifier, workflow verifier, package contents verifier, and packed-install verifier. The CLI verifier checks help/version output and startup failure behavior for malformed tools config, unknown tools-config keys, invalid environment values, invalid allowlists, and denied connection targets. The connection lifecycle verifier checks that tool `db.connect()` calls are awaited inside a `try` block whose `finally` awaits the matching `db.disconnect()`, and that tools receiving `getConnectionString` connect with resolver-derived values. The package verifier checks that the tarball includes required runtime files and excludes source, tests, caches, lockfiles, and local development artifacts.
