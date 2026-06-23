# PostgreSQL MCP Server Usage Guide

This guide covers the current hardened toolset. The complete parameter reference is in [TOOL_SCHEMAS.md](../TOOL_SCHEMAS.md).

## Security Baseline

Run the server with one fixed connection string and the least-privilege PostgreSQL role that matches the job. Per-tool `connectionString`, `sourceConnectionString`, and `targetConnectionString` arguments are disabled by default and should only be enabled for trusted local development.
Explicit per-tool, CLI, and `POSTGRES_CONNECTION_STRING` values must be non-empty strings. Blank higher-priority connection strings fail validation instead of falling back to lower-priority sources.
For deployments that enable per-tool connection strings, configure a connection target allowlist. Use `--allowed-connection-target`, the tools config `allowedConnectionTargets` array, or `POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS` with patterns such as `readonly@db.internal:5432/app` or `*@localhost:*/dev`.
Use [PostgreSQL Role Templates](POSTGRES_ROLES.md) to provision readonly, writer, schema-admin, and role-admin credentials that match the selected MCP mode.

Security modes are enforced before a tool reaches PostgreSQL:

- `readonly`: schema inspection, analysis, monitoring, and bounded SELECT-style query tools.
- `write`: readonly operations plus structured data mutations.
- `admin`: write operations plus DDL, roles, RLS, filesystem import/export, and migration-style tools.
- `unsafe`: arbitrary SQL and raw SQL fragments.

Destructive operations, including arbitrary SQL and drops/resets, also require `--allow-destructive`.

Runtime configuration precedence is CLI options, then the tools config file, then environment variables. Explicit `false` values in the tools config override enabling environment variables.

If a tools config path is provided, startup fails when that file is unreadable, malformed, non-object, incorrectly typed, or contains unknown keys. This avoids accidentally falling back to a broader tool surface or silently ignoring typoed security settings.

CLI options:

- `--version`
- `--connection-string`
- `--tools-config`
- `--security-mode`
- `--allow-destructive`
- `--allow-tool-connection-string`
- `--workspace-dir`
- `--audit-file`
- `--max-connections`
- `--idle-timeout-ms`
- `--connection-timeout-ms`
- `--max-file-bytes`
- `--statement-timeout-ms`
- `--query-timeout-ms`
- `--lock-timeout-ms`
- `--idle-in-transaction-session-timeout-ms`
- `--allowed-connection-target`

Environment variables:

- `POSTGRES_CONNECTION_STRING`
- `POSTGRES_TOOLS_CONFIG`
- `POSTGRES_MCP_SECURITY_MODE`
- `POSTGRES_MCP_ALLOW_DESTRUCTIVE`
- `POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING`
- `POSTGRES_MCP_WORKSPACE_DIR`
- `POSTGRES_MCP_AUDIT_FILE`
- `POSTGRES_MCP_MAX_CONNECTIONS`
- `POSTGRES_MCP_IDLE_TIMEOUT_MS`
- `POSTGRES_MCP_CONNECTION_TIMEOUT_MS`
- `POSTGRES_MCP_MAX_FILE_BYTES`
- `POSTGRES_MCP_STATEMENT_TIMEOUT_MS`
- `POSTGRES_MCP_QUERY_TIMEOUT_MS`
- `POSTGRES_MCP_LOCK_TIMEOUT_MS`
- `POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS`
- `POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS`
- `POSTGRES_MCP_DEBUG_SQL`

Tools config keys:

- `enabledTools`
- `securityMode`
- `allowDestructive`
- `allowToolConnectionString`
- `workspaceDir`
- `auditFile`
- `maxConnections`
- `idleTimeoutMillis`
- `connectionTimeoutMillis`
- `maxFileBytes`
- `statementTimeoutMs`
- `queryTimeoutMs`
- `lockTimeoutMs`
- `idleInTransactionSessionTimeoutMs`
- `allowedConnectionTargets`

```bash
POSTGRES_CONNECTION_STRING="postgresql://readonly_user:pass@localhost:5432/app" \
  npx @henkey/postgres-mcp-server

POSTGRES_CONNECTION_STRING="postgresql://writer:pass@localhost:5432/app" \
  npx @henkey/postgres-mcp-server --security-mode write

POSTGRES_CONNECTION_STRING="postgresql://admin:pass@localhost:5432/app" \
  npx @henkey/postgres-mcp-server --security-mode admin --allow-destructive
```

Connection target patterns use `[user@]host[:port][/database]`. Omitted fields are unconstrained, and `*` is accepted only as a full-field wildcard. When an allowlist is set, connection strings must be PostgreSQL URL or keyword-style strings with an explicit `host` or `hostaddr`.

## Common Read Workflows

Analyze database health:

```json
{
  "analysisType": "performance",
  "schema": "public"
}
```

Inspect schema:

```json
{
  "operation": "get_info",
  "schema": "public",
  "tableName": "users"
}
```

Run a bounded SELECT:

```json
{
  "operation": "select",
  "query": "SELECT id, email FROM users WHERE active = $1",
  "parameters": [true],
  "limit": 100,
  "timeout": 30000
}
```

`pg_execute_query` validates that the input is one read-only statement and wraps `select` in an outer `LIMIT`. `count` and `exists` evaluate the supplied SELECT without the select row limit, so use database permissions and timeouts appropriately.

Explain a query:

```json
{
  "operation": "explain",
  "query": "SELECT * FROM users WHERE email = $1",
  "format": "json",
  "analyze": false
}
```

EXPLAIN tools accept one read-only statement and run inside a read-only transaction. `analyze: true` still executes the supplied query and therefore requires `--security-mode unsafe --allow-destructive`.

## Structured Mutations

Mutations require `--security-mode write` or higher. Update and delete operations require a structured `where` predicate to prevent accidental table-wide changes.

```json
{
  "operation": "update",
  "table": "users",
  "data": { "active": false },
  "where": {
    "last_login": { "lt": "2024-01-01" },
    "active": true
  },
  "returning": ["id", "active"],
  "maxReturningRows": 100
}
```

Supported structured operators are `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, and `isNull`.

Legacy string `where` clauses are rejected. The explicit `rawWhere` field remains as a trusted local/admin escape hatch, is classified as arbitrary SQL, and requires `--security-mode unsafe --allow-destructive`.

## Filesystem Import And Export

Export/import tools require `--security-mode admin`, a configured workspace directory, and `.json` or `.csv` paths inside that workspace.

```bash
npx @henkey/postgres-mcp-server \
  --security-mode admin \
  --allow-destructive \
  --workspace-dir ./mcp-workspace \
  --connection-string "postgresql://admin:pass@localhost:5432/app"
```

```json
{
  "tableName": "users",
  "schema": "public",
  "outputPath": "exports/users.json",
  "format": "json",
  "where": { "active": true },
  "limit": 1000
}
```

The server rejects paths outside the workspace, rejects empty explicit workspace directory values, caps file size with `POSTGRES_MCP_MAX_FILE_BYTES` or `--max-file-bytes`, requires JSON imports to be arrays of objects, and always applies row limits to export and copy-between-databases reads. Export/copy `limit` defaults to 1000 and is capped at 100000.

## Arbitrary SQL

Use `pg_execute_sql` only for trusted administrative workflows. It requires `--security-mode unsafe --allow-destructive`.

```json
{
  "sql": "ALTER TABLE users ADD COLUMN last_seen timestamp",
  "expectRows": false,
  "transactional": true,
  "timeout": 60000
}
```

`maxRows` limits the MCP response payload only. It does not reduce database work for arbitrary SQL.

Multi-statement arbitrary SQL must be transactional, must set `expectRows: false`, and cannot use `parameters`. Use a single statement or CTE when bind parameters are needed.

## Output And Error Handling

The server sanitizes errors and redacts SQL text in diagnostics and catalog metadata by default. Query rows, mutation `RETURNING` data, comments, and enum values are intentionally returned as user data, so connect with roles scoped to what the client is allowed to see.

Security-boundary denials are also logged to stderr as `[MCP Audit]` JSON events. These events are intended for operational monitoring and contain sanitized metadata only, such as denial reason, tool name, mode, risk, and connection-string-presence flags. They do not include raw SQL, full request payloads, or connection-string passwords. Configure `POSTGRES_MCP_AUDIT_FILE`, `--audit-file`, or `auditFile` to append the same sanitized events to a JSONL file.

Configure runtime guardrails with:

- `POSTGRES_MCP_MAX_CONNECTIONS` or `--max-connections` to override the default 20 pool connections
- `POSTGRES_MCP_IDLE_TIMEOUT_MS` or `--idle-timeout-ms` to override the default 30000 ms pool idle timeout
- `POSTGRES_MCP_CONNECTION_TIMEOUT_MS` or `--connection-timeout-ms` to override the default 2000 ms connection timeout
- `POSTGRES_MCP_STATEMENT_TIMEOUT_MS` or `--statement-timeout-ms` to override the default 60000 ms PostgreSQL `statement_timeout`
- `POSTGRES_MCP_QUERY_TIMEOUT_MS` or `--query-timeout-ms` to override the default 65000 ms node-postgres query timeout
- `POSTGRES_MCP_LOCK_TIMEOUT_MS` or `--lock-timeout-ms` to override the default 10000 ms PostgreSQL `lock_timeout`
- `POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` or `--idle-in-transaction-session-timeout-ms` to override the default 60000 ms PostgreSQL `idle_in_transaction_session_timeout`
- `POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS` or repeated `--allowed-connection-target`
- `POSTGRES_MCP_DEBUG_SQL=true` only for trusted local debugging, because it may log raw SQL and bind values
