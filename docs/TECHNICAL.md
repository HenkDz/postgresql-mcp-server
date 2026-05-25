# PostgreSQL MCP Server Technical Notes

## Architecture

The server exposes PostgreSQL capabilities through Model Context Protocol tools. Runtime flow is:

1. CLI/config/environment options are loaded in `src/index.ts`.
2. MCP tool calls are classified by `src/security/policy.ts`.
3. Calls blocked by the active security mode or missing destructive opt-in are rejected before database access.
4. Tool schemas validate input with Zod.
5. SQL helpers quote identifiers, parameterize values, validate read-only SQL, and redact SQL text.
6. `DatabaseConnection` manages PostgreSQL pools, runtime timeouts, and sanitized error messages.

## Security Policy

Tool risks are:

- `read`
- `write`
- `ddl`
- `role_admin`
- `filesystem`
- `arbitrary_sql`
- `unclassified`

Modes allow progressively wider risk:

- `readonly`: `read`
- `write`: `read`, `write`
- `admin`: `read`, `write`, `ddl`, `role_admin`, `filesystem`
- `unsafe`: all risks, including `arbitrary_sql`

Destructive calls require `allowDestructive=true` even when the mode allows the risk. Arbitrary SQL is always destructive. Unclassified tools and unclassified operations are not allowed in any mode; new tool operations must be explicitly classified before they can run.

## SQL Safety

Identifier inputs are restricted to simple PostgreSQL identifiers and quoted server-side. Values are passed as bind parameters when PostgreSQL syntax allows it.

Structured predicates use:

```ts
type WherePredicate = Record<string, SqlScalar | WhereOperator>;
```

`buildWhereClause` produces parameterized DML predicates. `buildStaticWhereClause` exists for DDL contexts such as partial indexes, where bind parameters are not valid.

Read-only SQL validation accepts one `SELECT`, `WITH`, `VALUES`, or `TABLE` statement without semicolons and scans outside literals/comments for data-changing keywords. Read-only query and EXPLAIN paths also run inside read-only transactions where applicable.

## Redaction And Sanitization

`sanitizeErrorMessage` masks connection-string passwords and redacts SQL literals/comments before errors reach MCP responses or normal logs.

`redactSqlText` is applied to diagnostic SQL surfaces such as:

- `pg_stat_statements.query`
- active query and lock text
- function definitions
- trigger definitions
- RLS `USING` and `WITH CHECK` expressions
- CHECK constraints
- index definitions
- column defaults

Returned table rows, mutation `RETURNING` values, comments, and enum labels are considered user data and are not blanket-redacted.

Security boundary denials emit structured audit lines to stderr with the `[MCP Audit]` prefix. Events use a stable `postgres_mcp.security` name and include denial reason, tool name, current security mode, destructive opt-in state, per-tool connection-string state, and policy risk where applicable. They intentionally omit raw request payloads and raw SQL; policy-denial audit events rely on reason codes and risk fields instead of the full human error message.

`POSTGRES_MCP_AUDIT_FILE`, `--audit-file`, or the tools config `auditFile` key can also append these sanitized events to a JSONL file. File-write failures are logged as `[MCP Audit Error]` without exposing raw request payloads.

## Connection And Timeout Model

`DatabaseConnection` caches PostgreSQL pools by connection string and connection options. Runtime guardrails default to 20 max pool connections, a 30000 ms pool idle timeout, a 2000 ms connection timeout, a 60000 ms PostgreSQL `statement_timeout`, a 65000 ms node-postgres query timeout, a 10000 ms PostgreSQL `lock_timeout`, and a 60000 ms PostgreSQL `idle_in_transaction_session_timeout`. They can be configured with:

- `POSTGRES_MCP_MAX_CONNECTIONS`
- `POSTGRES_MCP_IDLE_TIMEOUT_MS`
- `POSTGRES_MCP_CONNECTION_TIMEOUT_MS`
- `POSTGRES_MCP_STATEMENT_TIMEOUT_MS`
- `POSTGRES_MCP_QUERY_TIMEOUT_MS`
- `POSTGRES_MCP_LOCK_TIMEOUT_MS`
- `POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS`
- `--max-connections`
- `--idle-timeout-ms`
- `--connection-timeout-ms`
- `--statement-timeout-ms`
- `--query-timeout-ms`
- `--lock-timeout-ms`
- `--idle-in-transaction-session-timeout-ms`

`statementTimeoutMs` maps to PostgreSQL `statement_timeout`, `queryTimeoutMs` is passed to node-postgres as query timeout, `lockTimeoutMs` maps to PostgreSQL `lock_timeout`, and `idleInTransactionSessionTimeoutMs` maps to PostgreSQL `idle_in_transaction_session_timeout`. Some tools also accept per-call `timeout`.

The singleton `DatabaseConnection` serializes active `connect` to `disconnect` workflows. Concurrent MCP tool calls therefore cannot switch the active pool out from under another in-flight tool call; the next workflow waits until the current one disconnects while cached pools remain reusable.

Per-tool connection string arguments are disabled by default by the server boundary. Prefer a fixed server-level connection string with a least-privilege PostgreSQL role.

Connection target allowlists are configured with `--allowed-connection-target`, `allowedConnectionTargets`, or `POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS`. Patterns use `[user@]host[:port][/database]`, with omitted fields unconstrained and `*` allowed only as a full-field wildcard. Server-level sources are checked during connection resolution; per-tool `connectionString`, `sourceConnectionString`, and `targetConnectionString` values are checked at the request boundary before tool execution.

## Lifecycle

Server shutdown is idempotent. `SIGINT`, `SIGTERM`, explicit `close()`, and failed startup cleanup all share the same cleanup path, remove registered signal handlers, close cached PostgreSQL pools, and close the MCP server. Repeated process signals share one signal-triggered shutdown promise so cleanup and process exit are not duplicated. Cleanup attempts both pool and MCP-server shutdown even if one side fails; signal-triggered cleanup exits with a nonzero code if cleanup fails.

## Container Runtime

The Docker image uses a multi-stage build. The build stage installs full dependencies and compiles TypeScript; the runtime stage copies only `package.json`, production `node_modules`, `build/`, and the entrypoint. The container runs as the non-root `node` user.

The Docker entrypoint does not assemble a shell command from environment variables. It directly executes `node build/index.js "$@"`; runtime configuration remains handled by the server's CLI and environment parser.

## Filesystem Sandbox

Import/export paths are resolved through `src/utils/filesystem.ts`.

Rules:

- A workspace directory must be configured.
- Paths must stay inside that workspace after resolution.
- Only `.json` and `.csv` files are accepted by migration tools.
- File size is capped by `POSTGRES_MCP_MAX_FILE_BYTES` or `--max-file-bytes`.
- Successful responses avoid echoing resolved absolute host paths.

## Testing Strategy

Most tests mock `DatabaseConnection` and assert generated SQL, parameter arrays, policy classification, output caps, and redaction behavior. Use:

```bash
npm run test:run
```

Build verification is:

```bash
npm run build
```
