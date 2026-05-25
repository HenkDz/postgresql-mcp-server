# PostgreSQL MCP Server Documentation

Start with the current authoritative docs:

- [README](../README.md): installation, security modes, runtime options, and feature overview.
- [Security Posture](../SECURITY.md): sandboxing, approvals, audit events, non-goals, and deployment checklist.
- [Complete Tool Schema Reference](../TOOL_SCHEMAS.md): all tool parameters, examples, limits, and security notes.

Supporting docs:

- [Usage Guide](USAGE.md): common hardened workflows.
- [PostgreSQL Role Templates](POSTGRES_ROLES.md): least-privilege database grants for readonly, writer, schema-admin, and role-admin deployments.
- [Technical Notes](TECHNICAL.md): architecture, security policy, SQL safety, redaction, filesystem sandbox, and timeout model.
- [Developer Guide](DEVELOPER.md): contribution workflow, test commands, and security rules for new tools.
- [Development Guide](DEVELOPMENT.md): setup, change workflow, documentation rules, and release checklist.

## Security Defaults

The server starts in `readonly` mode. Per-tool connection strings are disabled by default. DML requires `write`, DDL/filesystem/roles require `admin`, arbitrary SQL and raw SQL fragments require `unsafe`, and destructive operations also require `--allow-destructive`.

Use a fixed server-level PostgreSQL connection string and a least-privilege database role whenever possible. Start from [PostgreSQL Role Templates](POSTGRES_ROLES.md) when provisioning deployment credentials.

## Quick Commands

```bash
npm install
npm run test:run
npm run build
```

```bash
POSTGRES_CONNECTION_STRING="postgresql://readonly_user:pass@localhost:5432/app" \
  npx @henkey/postgres-mcp-server
```
