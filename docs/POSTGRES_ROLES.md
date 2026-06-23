# PostgreSQL Role Templates

This server's MCP policy is an application boundary, not a replacement for PostgreSQL privileges. Use one fixed server-level connection string for a role that matches the configured `securityMode`.

The examples below are templates. Run them as a database owner or DBA, replace the names, and scope grants to the schemas and objects the MCP server should actually manage.

## Baseline Principles

- Do not use a superuser role for routine MCP access.
- Do not give `CREATEDB`, `CREATEROLE`, `BYPASSRLS`, or replication privileges to read or write profiles.
- Prefer one role per deployment profile: readonly, writer, schema admin, and role admin should be separate credentials.
- Keep `--security-mode` aligned with the PostgreSQL grants. A `readonly` server should connect as a read-only database role.
- Use `enabledTools` to hide tools that the connected database role should never exercise.
- Use connection target allowlists when per-tool connection strings are enabled.

The snippets use psql variables:

```sql
\set app_db 'app'
\set app_schema 'public'
\set app_owner 'app_owner'
\set mcp_readonly 'mcp_readonly'
\set mcp_readonly_password 'change-me-readonly'
\set mcp_writer 'mcp_writer'
\set mcp_writer_password 'change-me-writer'
\set mcp_schema_admin 'mcp_schema_admin'
\set mcp_schema_admin_password 'change-me-schema-admin'
```

## Readonly Role

Use this with the default `readonly` security mode. It supports schema inspection, analysis, monitoring, and bounded read-only query tools over the granted schemas.

```sql
CREATE ROLE :"mcp_readonly"
  LOGIN
  PASSWORD :'mcp_readonly_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS;

GRANT CONNECT ON DATABASE :"app_db" TO :"mcp_readonly";
GRANT USAGE ON SCHEMA :"app_schema" TO :"mcp_readonly";
GRANT SELECT ON ALL TABLES IN SCHEMA :"app_schema" TO :"mcp_readonly";

ALTER DEFAULT PRIVILEGES FOR ROLE :"app_owner" IN SCHEMA :"app_schema"
  GRANT SELECT ON TABLES TO :"mcp_readonly";
```

Optional monitoring visibility:

```sql
GRANT pg_monitor TO :"mcp_readonly";
```

`pg_monitor` exposes broader server activity and statistics. Skip it when the MCP client should only see objects and activity visible to the application role.

## Writer Role

Use this with `--security-mode write` for structured `INSERT`, `UPDATE`, and `DELETE` workflows. It inherits the read profile and adds DML privileges over the selected schema.

```sql
CREATE ROLE :"mcp_writer"
  LOGIN
  PASSWORD :'mcp_writer_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS;

GRANT CONNECT ON DATABASE :"app_db" TO :"mcp_writer";
GRANT USAGE ON SCHEMA :"app_schema" TO :"mcp_writer";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA :"app_schema" TO :"mcp_writer";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA :"app_schema" TO :"mcp_writer";

ALTER DEFAULT PRIVILEGES FOR ROLE :"app_owner" IN SCHEMA :"app_schema"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO :"mcp_writer";
ALTER DEFAULT PRIVILEGES FOR ROLE :"app_owner" IN SCHEMA :"app_schema"
  GRANT USAGE, SELECT ON SEQUENCES TO :"mcp_writer";
```

Only grant `TRUNCATE` if a trusted workflow explicitly needs it. Most mutation tools do not require it.

## Schema Admin Role

Use this with `--security-mode admin` only for trusted schema maintenance. This profile can create new objects in the selected schema, but PostgreSQL still requires object ownership or owner-role membership to alter or drop existing objects.

```sql
CREATE ROLE :"mcp_schema_admin"
  LOGIN
  PASSWORD :'mcp_schema_admin_password'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOREPLICATION
  NOBYPASSRLS;

GRANT CONNECT ON DATABASE :"app_db" TO :"mcp_schema_admin";
GRANT USAGE, CREATE ON SCHEMA :"app_schema" TO :"mcp_schema_admin";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA :"app_schema" TO :"mcp_schema_admin";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA :"app_schema" TO :"mcp_schema_admin";
```

For migration-style work on existing application objects, prefer a purpose-built migration role owned by the deployment system. Avoid giving the MCP role ownership of unrelated schemas.

## Role Administration

Tools that create, alter, grant, revoke, or drop roles require `--security-mode admin` and PostgreSQL role administration privileges. Keep that deployment separate from schema or data maintenance.

Recommended controls:

- Use a short-lived credential.
- Restrict `enabledTools` to role-management tools only.
- Configure `--allowed-connection-target` for the exact host, database, and role.
- Enable persistent audit output with `--audit-file`.
- Avoid `SUPERUSER`; if PostgreSQL `CREATEROLE` is required, treat it as high-risk access and review every generated grant before use.

## Unsafe Mode

`--security-mode unsafe --allow-destructive` can run arbitrary SQL and trusted raw SQL fragments. Do not pair unsafe mode with production superuser credentials. For emergency production maintenance, use a short-lived, task-specific PostgreSQL role and a narrow `enabledTools` list.
