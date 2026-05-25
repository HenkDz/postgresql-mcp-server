# Security Posture

This server is security-first by default, but it is not a database firewall and it does not replace PostgreSQL permissions. Treat it as a controlled MCP request boundary in front of a PostgreSQL role that should already be least-privilege.

## Default Runtime Boundary

The default mode is `readonly`. Tools may be listed for MCP discovery, but every call is classified before it can reach PostgreSQL.

| Control | Default | Purpose |
| --- | --- | --- |
| `securityMode` | `readonly` | Allows read-only inspection and SELECT-style query tools only. |
| `allowDestructive` | `false` | Blocks destructive operations even when the selected mode would otherwise allow their risk category. |
| `allowToolConnectionString` | `false` | Rejects per-tool `connectionString`, `sourceConnectionString`, and `targetConnectionString` arguments. |
| `enabledTools` | all listed | Tool discovery remains broad, but calls are still policy-checked. Use `enabledTools` for a stricter allow-list. |
| filesystem workspace | unset | Import/export tools cannot access files until a workspace is configured. |

Mode escalation is explicit:

- `readonly`: schema inspection, analysis, monitoring, and read-only query tools.
- `write`: `readonly` plus structured data mutations.
- `admin`: `write` plus DDL, roles, RLS, filesystem import/export, and migration-style tools.
- `unsafe`: arbitrary SQL and raw SQL fragments.

Destructive calls, including drops, resets, arbitrary SQL, trusted raw SQL fragments, elevated role attributes, broad grants, and delegable grants require `allowDestructive=true` in addition to an allowing mode.

## Sandboxing

The server has three main sandbox boundaries:

- PostgreSQL permissions: the connection role is the strongest boundary. Use a fixed server-level connection string for a role scoped to the job.
- MCP policy: each tool call is classified by risk and checked against the active security mode before database access.
- Filesystem workspace: import/export paths must resolve inside `POSTGRES_MCP_WORKSPACE_DIR` or `--workspace-dir`, must use `.json` or `.csv`, and are capped by `POSTGRES_MCP_MAX_FILE_BYTES` or `--max-file-bytes`.

Connection target allowlists add another boundary when per-tool connection strings are enabled. Configure repeated `--allowed-connection-target`, tools config `allowedConnectionTargets`, or `POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS`. Patterns use `[user@]host[:port][/database]`; omitted fields are unconstrained and `*` is accepted only as a full-field wildcard.

The Docker image uses a multi-stage build, production dependencies only in the runtime stage, and runs as the non-root `node` user. This reduces host risk, but container isolation is still provided by the container runtime and deployment platform.

For concrete PostgreSQL grants, use [PostgreSQL Role Templates](docs/POSTGRES_ROLES.md). The templates separate readonly, writer, schema-admin, and role-admin credentials so MCP policy mode and database privileges can be aligned.

## Approvals

The server does not prompt interactively for approvals during MCP tool execution. Approval is modeled as explicit deployment configuration:

- starting in `write`, `admin`, or `unsafe` mode;
- setting `--allow-destructive` or `POSTGRES_MCP_ALLOW_DESTRUCTIVE=true`;
- setting `--allow-tool-connection-string` or `POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING=true`;
- configuring an `enabledTools` allow-list;
- configuring connection target allowlists.

MCP clients may add their own human approval prompts before calling tools. The server-side controls still apply if a client prompt is bypassed, absent, or misconfigured.

## Notable Non-Goals

- This server does not parse and prove arbitrary SQL safety. `pg_execute_sql` is deliberately classified as `arbitrary_sql` and requires `unsafe` plus destructive opt-in.
- This server does not redact normal query rows, mutation `RETURNING` data, comments, or enum labels. Those are treated as user data. Scope the database role accordingly.
- This server does not grant network egress restrictions by itself. Use container, host, firewall, or orchestration policy for network isolation.
- This server does not store credentials. Connection strings are accepted at runtime from CLI, environment, or explicitly enabled tool arguments.

## Audit And Logging

Security-boundary denials emit one structured stderr line prefixed with `[MCP Audit]`. Audit events include sanitized fields such as:

- denial reason;
- tool name;
- security mode;
- destructive opt-in state;
- per-tool connection-string presence;
- policy risk.

Audit events intentionally omit raw request payloads, raw SQL, and connection-string passwords. Set `POSTGRES_MCP_AUDIT_FILE`, `--audit-file`, or `auditFile` to append the same sanitized events to a JSONL file. File-write failures are logged as `[MCP Audit Error]` and do not include raw request payloads.

`POSTGRES_MCP_DEBUG_SQL=true` enables verbose `pg-monitor` SQL tracing and may log raw SQL and bind values. Use it only for trusted local debugging.

## Recommended Deployment Profiles

Read-only inspection:

```bash
POSTGRES_CONNECTION_STRING="postgresql://readonly_user:pass@db.internal:5432/app" \
  npx @henkey/postgres-mcp-server
```

Application data maintenance:

```bash
POSTGRES_CONNECTION_STRING="postgresql://writer:pass@db.internal:5432/app" \
  npx @henkey/postgres-mcp-server --security-mode write
```

Administrative maintenance:

```bash
POSTGRES_CONNECTION_STRING="postgresql://admin:pass@db.internal:5432/app" \
  npx @henkey/postgres-mcp-server \
    --security-mode admin \
    --allow-destructive \
    --workspace-dir /var/lib/postgres-mcp/workspace \
    --allowed-connection-target "admin@db.internal:5432/app"
```

Trusted arbitrary SQL:

```bash
POSTGRES_CONNECTION_STRING="postgresql://admin:pass@db.internal:5432/app" \
  npx @henkey/postgres-mcp-server --security-mode unsafe --allow-destructive
```

## Operational Checklist

- Use a least-privilege PostgreSQL role.
- Start from [PostgreSQL Role Templates](docs/POSTGRES_ROLES.md) for readonly, writer, schema-admin, and role-admin deployments.
- Prefer one fixed server-level connection string.
- Keep per-tool connection strings disabled unless the workflow genuinely needs them.
- If per-tool connection strings are enabled, configure connection target allowlists.
- Use `enabledTools` to reduce the available surface for production deployments.
- Review the default 20 max pool connections, 30000 ms pool idle timeout, 2000 ms connection timeout, default 60000 ms statement timeout, 65000 ms query timeout, 10000 ms lock timeout, and 60000 ms idle-in-transaction timeout; raise or lower them explicitly with `--max-connections`, `POSTGRES_MCP_MAX_CONNECTIONS`, `POSTGRES_MCP_IDLE_TIMEOUT_MS`, `POSTGRES_MCP_CONNECTION_TIMEOUT_MS`, `POSTGRES_MCP_STATEMENT_TIMEOUT_MS`, `POSTGRES_MCP_QUERY_TIMEOUT_MS`, `POSTGRES_MCP_LOCK_TIMEOUT_MS`, and `POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS` for the deployment.
- Configure a filesystem workspace only when import/export tools are required.
- Ship stderr logs to monitoring and alert on `[MCP Audit]` denials, or configure `POSTGRES_MCP_AUDIT_FILE` for JSONL audit persistence.
- Leave `POSTGRES_MCP_DEBUG_SQL` disabled outside trusted local debugging.
- Run `npm run prepublishOnly` before publishing or deploying changed code.
