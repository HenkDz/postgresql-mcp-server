# PostgreSQL MCP Server
[![smithery badge](https://smithery.ai/badge/@HenkDz/postgresql-mcp-server)](https://smithery.ai/server/@HenkDz/postgresql-mcp-server)

<a href="https://glama.ai/mcp/servers/@HenkDz/postgresql-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@HenkDz/postgresql-mcp-server/badge" alt="PostgreSQL Server MCP server" />
</a>

A Model Context Protocol (MCP) server that provides comprehensive PostgreSQL database management capabilities for AI assistants.

**🚀 What's New**: This server has been completely redesigned from 46 individual tools to 18 intelligent tools through consolidation (34→8 meta-tools) and enhancement (+4 new tools), providing better AI discovery while adding powerful data manipulation and comment management capabilities.

## Breaking Changes in 2.0.0

Version 2.0.0 introduces security boundaries that intentionally change default behavior from the 1.x line:

- The server starts in `readonly` mode. Mutations, DDL, role administration, filesystem import/export, and arbitrary SQL require `--security-mode write`, `--security-mode admin`, or `--security-mode unsafe` as appropriate.
- Destructive operations such as drops, resets, broad role grants, and arbitrary SQL require `--allow-destructive`.
- Per-tool `connectionString`, `sourceConnectionString`, and `targetConnectionString` arguments are disabled by default. Use server-level `--connection-string` or `POSTGRES_CONNECTION_STRING`, or explicitly opt in with `--allow-tool-connection-string`.
- Legacy string `where` clauses are rejected for mutation, index, export, and copy filters. Use structured `where` predicates, or `rawWhere` only with `--security-mode unsafe --allow-destructive`.
- Multi-statement `pg_execute_sql` calls must use `transactional: true`, `expectRows: false`, and no bind `parameters`.
- Tool schemas reject unknown fields, so misspelled or unintended inputs fail before connection resolution.
- User and target identifiers are restricted to safe simple PostgreSQL identifiers.

For the non-breaking security patch line, use `@henkey/postgres-mcp-server@1.0.7`.

## Quick Start

## Prerequisites
- Node.js ≥18.0.0
- Access to a PostgreSQL server
- (Optional) An MCP client like Cursor or Claude for AI integration

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=postgresql-mcp&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIkBoZW5rZXkvcG9zdGdyZXMtbWNwLXNlcnZlciIsIi0tY29ubmVjdGlvbi1zdHJpbmciLCJwb3N0Z3Jlc3FsOi8vdXNlcjpwYXNzd29yZEBob3N0OnBvcnQvZGF0YWJhc2UiXX0=)

### Option 1: npm (Recommended)
```bash
# Install globally
npm install -g @henkey/postgres-mcp-server

# Or run directly with npx (no installation)
# Use env var for connection string (optional)
export POSTGRES_CONNECTION_STRING="postgresql://user:pass@localhost:5432/db"
npx @henkey/postgres-mcp-server
# Or pass directly:
npx @henkey/postgres-mcp-server --connection-string "postgresql://user:pass@localhost:5432/db"
```

# Verify installation
npx @henkey/postgres-mcp-server --help

Add to your MCP client configuration:
```json
{
  "mcpServers": {
    "postgresql-mcp": {
      "command": "npx",
      "args": [
        "@henkey/postgres-mcp-server",
        "--connection-string", "postgresql://user:password@host:port/database"
      ]
    }
  }
}
```

### Option 2: Install via Smithery
```bash
npx -y @smithery/cli install @HenkDz/postgresql-mcp-server --client claude
```

### Option 3: Docker (Recommended for Production)
```bash
# Build the Docker image
docker build -t postgres-mcp-server .

# Run with environment variable
docker run -i --rm \
  -e POSTGRES_CONNECTION_STRING="postgresql://user:password@host:port/database" \
  postgres-mcp-server
```

Add to your MCP client configuration:
```json
{
  "mcpServers": {
    "postgresql-mcp": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "henkey/postgres-mcp:latest",
        "-e",
        "POSTGRES_CONNECTION_STRING"
      ],
      "env": {
        "POSTGRES_CONNECTION_STRING": "postgresql://user:password@host:port/database"
      }
    }
  }
}
```

### Option 4: Manual Installation (Development)
```bash
git clone <repository-url>
cd postgresql-mcp-server
npm install
npm run build
```

Add to your MCP client configuration:
```json
{
  "mcpServers": {
    "postgresql-mcp": {
      "command": "node",
      "args": [
        "/path/to/postgresql-mcp-server/build/index.js",
        "--connection-string", "postgresql://user:password@host:port/database"
      ]
    }
  }
}
```

## Security Modes

The server now starts in `readonly` mode by default. Tools may still be listed for MCP discovery, but every call is classified and checked before it reaches the database.

| Mode | Allows | Blocks by default |
| ---- | ------ | ----------------- |
| `readonly` | schema inspection, analysis, monitoring, SELECT-style query tools | mutations, DDL, role changes, filesystem import/export, arbitrary SQL |
| `write` | readonly operations plus data mutations | DDL, role changes, filesystem import/export, arbitrary SQL |
| `admin` | write operations plus schema, index, function, trigger, RLS, role, and filesystem tools | arbitrary SQL |
| `unsafe` | all tool categories, including arbitrary SQL | destructive operations unless explicitly allowed |

Destructive operations such as drops, resets, and arbitrary SQL also require explicit opt-in:

```bash
# Default: readonly, no per-tool connection strings
npx @henkey/postgres-mcp-server --connection-string "postgresql://readonly_user:pass@host:5432/db"

# Enable DML mutations, but still block DDL/admin/arbitrary SQL
npx @henkey/postgres-mcp-server --security-mode write --connection-string "postgresql://app_writer:pass@host:5432/db"

# Enable admin tools and destructive operations
npx @henkey/postgres-mcp-server --security-mode admin --allow-destructive --connection-string "postgresql://admin_user:pass@host:5432/db"

# Enable arbitrary SQL only for trusted local/admin use
npx @henkey/postgres-mcp-server --security-mode unsafe --allow-destructive --connection-string "postgresql://admin_user:pass@host:5432/db"
```

Per-tool `connectionString`, `sourceConnectionString`, and `targetConnectionString` arguments are disabled by default. Prefer a fixed server-level connection string with a least-privilege PostgreSQL role. For development only, enable per-tool connection strings with `--allow-tool-connection-string` or `POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING=true`.
Explicit per-tool, CLI, and `POSTGRES_CONNECTION_STRING` values must be non-empty strings. Blank higher-priority connection strings fail validation instead of falling back to lower-priority sources.

Optionally restrict all server-level and per-tool connection strings to an allowlist with `--allowed-connection-target`, `allowedConnectionTargets`, or `POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS`. Target patterns use `[user@]host[:port][/database]`; omitted fields are unconstrained and `*` is allowed only as a full-field wildcard, for example `readonly@db.internal:5432/app` or `*@localhost:*/dev`.

For deployment grants, see [PostgreSQL Role Templates](./docs/POSTGRES_ROLES.md). The templates split readonly, writer, schema-admin, and role-admin credentials so the PostgreSQL role remains aligned with the selected MCP `securityMode`.

Security settings can also be placed in the tools config file:

```json
{
  "securityMode": "readonly",
  "allowDestructive": false,
  "allowToolConnectionString": false,
  "workspaceDir": "/path/to/mcp-workspace",
  "auditFile": "/path/to/postgres-mcp-audit.jsonl",
  "maxConnections": 20,
  "idleTimeoutMillis": 30000,
  "connectionTimeoutMillis": 2000,
  "maxFileBytes": 10485760,
  "statementTimeoutMs": 30000,
  "queryTimeoutMs": 45000,
  "lockTimeoutMs": 10000,
  "idleInTransactionSessionTimeoutMs": 60000,
  "allowedConnectionTargets": [
    "readonly@db.internal:5432/app"
  ],
  "enabledTools": [
    "pg_analyze_database",
    "pg_manage_schema",
    "pg_execute_query"
  ]
}
```

Runtime configuration precedence is CLI options, then the tools config file, then environment variables. Explicit `false` values in the tools config override enabling environment variables such as `POSTGRES_MCP_ALLOW_DESTRUCTIVE=true`.

If a tools config path is provided, the server treats it as required: unreadable, malformed, non-object, incorrectly typed, unknown-key, invalid `securityMode`, or unknown `enabledTools` entries stop startup instead of falling back to all available tools.

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

- `POSTGRES_TOOLS_CONFIG=/path/to/tools.json`
- `POSTGRES_MCP_SECURITY_MODE=readonly|write|admin|unsafe`
- `POSTGRES_MCP_ALLOW_DESTRUCTIVE=true`
- `POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING=true`
- `POSTGRES_MCP_WORKSPACE_DIR=/path/to/mcp-workspace`
- `POSTGRES_MCP_AUDIT_FILE=/path/to/postgres-mcp-audit.jsonl`
- `POSTGRES_MCP_MAX_CONNECTIONS=20`
- `POSTGRES_MCP_IDLE_TIMEOUT_MS=30000`
- `POSTGRES_MCP_CONNECTION_TIMEOUT_MS=2000`
- `POSTGRES_MCP_MAX_FILE_BYTES=10485760`
- `POSTGRES_MCP_STATEMENT_TIMEOUT_MS=60000`
- `POSTGRES_MCP_QUERY_TIMEOUT_MS=65000`
- `POSTGRES_MCP_LOCK_TIMEOUT_MS=10000`
- `POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS=60000`
- `POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS=readonly@db.internal:5432/app,*@localhost:*/dev`
- `POSTGRES_MCP_DEBUG_SQL=true` to opt into verbose `pg-monitor` SQL tracing. This may log raw SQL and bind values, so leave it disabled unless you are debugging a trusted local database.

Boolean environment flags must be exactly `true` or `false` when set.
Numeric resource settings from CLI, tools config, or environment variables must be positive integers. Runtime defaults use a 20-connection pool, a 30000 ms pool idle timeout, a 2000 ms connection timeout, a 60000 ms PostgreSQL `statement_timeout`, a 65000 ms node-postgres query timeout, a 10000 ms PostgreSQL `lock_timeout`, and a 60000 ms PostgreSQL `idle_in_transaction_session_timeout`. Pool and timeout settings can be raised or lowered with `--max-connections`, `--idle-timeout-ms`, `--connection-timeout-ms`, `--statement-timeout-ms`, `--query-timeout-ms`, `--lock-timeout-ms`, `--idle-in-transaction-session-timeout-ms`, `maxConnections`, `idleTimeoutMillis`, `connectionTimeoutMillis`, `statementTimeoutMs`, `queryTimeoutMs`, `lockTimeoutMs`, `idleInTransactionSessionTimeoutMs`, `POSTGRES_MCP_MAX_CONNECTIONS`, `POSTGRES_MCP_IDLE_TIMEOUT_MS`, `POSTGRES_MCP_CONNECTION_TIMEOUT_MS`, `POSTGRES_MCP_STATEMENT_TIMEOUT_MS`, `POSTGRES_MCP_QUERY_TIMEOUT_MS`, `POSTGRES_MCP_LOCK_TIMEOUT_MS`, or `POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS`.
Explicit connection string, `workspaceDir`, `auditFile`, `--workspace-dir`, and `--audit-file` values must be non-empty strings.
Connection target allowlists are enforced before tool execution for per-tool connection strings and during connection resolution for server-level sources. When an allowlist is configured, connection strings must be PostgreSQL URL or keyword-style strings with an explicit `host` or `hostaddr`.

Mutation, index, export, and copy filters should use structured `where` predicates. Legacy string `where` clauses are rejected; the explicit `rawWhere` escape hatch is treated as arbitrary SQL and requires `--security-mode unsafe --allow-destructive`.

EXPLAIN tools only accept one read-only statement and run inside a read-only transaction. `analyze: true` still requires unsafe mode because PostgreSQL executes the supplied query to collect runtime statistics.

Multi-statement `pg_execute_sql` calls must use `transactional: true`, `expectRows: false`, and no bind `parameters`. Use a single parameterized statement or CTE when bind parameters are needed.

Error messages, diagnostics, and catalog metadata are sanitized by default. SQL text from `pg_stat_statements`, function definitions, RLS predicates, check constraints, index definitions, and column defaults are redacted unless they are intentionally returned as user data.
Data execution, query/performance, schema, index, constraint, user/permission, trigger, comment, function, RLS, migration, and diagnostic tools reject unknown input fields so misspelled or unintended parameters fail before connection resolution.

Denied security-boundary requests emit one structured stderr line prefixed with `[MCP Audit]`. Audit events include sanitized fields such as `toolName`, `reason`, `securityMode`, `risk`, and whether per-tool connection strings were present; they do not log raw SQL, full request payloads, or connection-string passwords. Set `POSTGRES_MCP_AUDIT_FILE`, `--audit-file`, or `auditFile` to append the same sanitized audit events to a JSONL file.

Filesystem tools such as table export/import require a workspace directory and only read or write `.json` and `.csv` files inside it:

```bash
npx @henkey/postgres-mcp-server \
  --security-mode admin \
  --allow-destructive \
  --workspace-dir /path/to/mcp-workspace \
  --connection-string "postgresql://admin_user:pass@host:5432/db"
```

## What's Included

**18 powerful tools** organized into three categories:
- **🔄 Consolidation**: 34 original tools consolidated into 8 intelligent meta-tools
- **🔧 Specialized**: 6 tools kept separate for complex operations
- **🆕 Enhancement**: 4 brand new tools (not in original 46)

### 📊 **Consolidated Meta-Tools** (8 tools)
- **Schema Management** - Tables, columns, ENUMs, constraints
- **User & Permissions** - Create users, grant/revoke permissions  
- **Query Performance** - EXPLAIN plans, slow queries, statistics
- **Index Management** - Create, analyze, optimize indexes
- **Functions** - Create, modify, manage stored functions
- **Triggers** - Database trigger management
- **Constraints** - Foreign keys, checks, unique constraints
- **Row-Level Security** - RLS policies and management

### 🚀 **Enhancement Tools** (4 NEW tools) 
*Brand new capabilities not available in the original 46 tools*
- **Execute Query** - SELECT operations with count/exists support
- **Execute Mutation** - INSERT/UPDATE/DELETE/UPSERT operations  
- **Execute SQL** - Arbitrary SQL execution with transaction support
- **Comments Management** - Comprehensive comment management for all database objects

### 🔧 **Specialized Tools** (6 tools)
- **Database Analysis** - Performance and configuration analysis
- **Debug Database** - Troubleshoot connection, performance, locks
- **Data Export** - JSON/CSV data export
- **Data Import** - JSON/CSV data import
- **Copy Between Databases** - Cross-database data transfer  
- **Real-time Monitoring** - Live database metrics and alerts

## Example Usage

```typescript
// Analyze database performance
{ "analysisType": "performance", "schema": "public" }

// Create a table with constraints
{
  "operation": "create_table",
  "tableName": "users", 
  "columns": [
    { "name": "id", "type": "SERIAL PRIMARY KEY" },
    { "name": "email", "type": "VARCHAR(255) UNIQUE NOT NULL" }
  ]
}

// Query data with parameters
{
  "operation": "select",
  "query": "SELECT * FROM users WHERE created_at > $1",
  "parameters": ["2024-01-01"],
  "limit": 100
}
// Select results are always bounded: default limit 100, max 1000.

// Insert new data
{
  "operation": "insert",
  "table": "users",
  "data": {"name": "John Doe", "email": "john@example.com"},
  "returning": "*",
  "maxReturningRows": 100
}
// Mutation RETURNING output is capped in the response: default 100, max 1000.

// Find slow queries
{
  "operation": "get_slow_queries",
  "limit": 5,
  "minDuration": 100
}

// Execute a parameterized SELECT query
{
  "operation": "select",
  "query": "SELECT * FROM users WHERE id = $1",
  "parameters": [1]
}

// Perform an INSERT mutation
{
  "operation": "insert",
  "table": "products",
  "data": {"name": "New Product", "price": 99.99},
  "returning": "id",
  "maxReturningRows": 100
}

// Perform an UPDATE mutation with a structured WHERE predicate
{
  "operation": "update",
  "table": "products",
  "data": {"price": 89.99},
  "where": {"id": 123},
  "returning": ["id", "price"]
}

// Manage database object comments
{
  "operation": "set",
  "objectType": "table",
  "objectName": "users",
  "comment": "Main user account information table"
}
```

## 📚 Documentation

**📋 [Complete Tool Schema Reference](./TOOL_SCHEMAS.md)** - All 18 tool parameters & examples in one place

For additional information, see the [`docs/`](./docs/) folder:

- **[🔐 Security Posture](./SECURITY.md)** - Sandboxing, approvals, audit events, and deployment posture
- **[PostgreSQL Role Templates](./docs/POSTGRES_ROLES.md)** - Least-privilege database roles for each deployment profile
- **[📖 Usage Guide](./docs/USAGE.md)** - Hardened usage patterns and examples
- **[🛠️ Development Guide](./docs/DEVELOPMENT.md)** - Setup and release checklist
- **[⚙️ Technical Details](./docs/TECHNICAL.md)** - Security architecture and implementation constraints
- **[👨‍💻 Developer Reference](./docs/DEVELOPER.md)** - Contribution rules for tool and policy changes
- **[📋 Documentation Index](./docs/INDEX.md)** - Complete documentation overview

## Features Highlights

### **🔄 Consolidation Achievements**
✅ **34→8 meta-tools** - Intelligent consolidation for better AI discovery  
✅ **Multiple operations per tool** - Unified schemas with operation parameters  
✅ **Smart parameter validation** - Clear error messages and type safety

### **🆕 Enhanced Data Capabilities** 
✅ **Complete CRUD operations** - INSERT/UPDATE/DELETE/UPSERT with parameterized queries  
✅ **Flexible querying** - SELECT with count/exists support and bounded safety limits
✅ **Arbitrary SQL execution** - Transaction support for complex operations

### **🔧 Production Ready**
✅ **Controlled connection** - CLI args or env vars by default; per-tool connection strings require opt-in
✅ **Security focused** - Read-only default mode, centralized policy checks, structured mutation predicates
✅ **Robust architecture** - Connection pooling, comprehensive error handling

## Docker Usage

The PostgreSQL MCP Server is fully Docker-compatible and can be used in production environments. The image uses a multi-stage build, installs only production dependencies in the runtime stage, and runs as the non-root `node` user.

### Building the Image
```bash
# Build locally
docker build -t postgres-mcp-server .

# Or pull from Docker Hub
docker pull henkey/postgres-mcp:latest
```

### Running with Environment Variables
```bash
# Basic usage (using Docker Hub image)
docker run -i --rm \
  -e POSTGRES_CONNECTION_STRING="postgresql://user:password@host:port/database" \
  henkey/postgres-mcp:latest

# Or with locally built image
docker run -i --rm \
  -e POSTGRES_CONNECTION_STRING="postgresql://user:password@host:port/database" \
  postgres-mcp-server

# With tools configuration
docker run -i --rm \
  -e POSTGRES_CONNECTION_STRING="postgresql://user:password@host:port/database" \
  -e POSTGRES_TOOLS_CONFIG="/app/config/tools.json" \
  -v /path/to/config:/app/config \
  postgres-mcp-server
```

### Docker Compose Example
```yaml
version: '3.8'
services:
  postgres-mcp:
    build: .
    environment:
      - POSTGRES_CONNECTION_STRING=postgresql://user:password@postgres:5432/database
    depends_on:
      - postgres
    stdin_open: true
    tty: true

  postgres:
    image: postgres:15
    environment:
      - POSTGRES_DB=database
      - POSTGRES_USER=user
      - POSTGRES_PASSWORD=password
    ports:
      - "5432:5432"
```

### MCP Client Configuration
For use with MCP clients like Cursor or Claude Desktop:

```json
{
  "mcpServers": {
    "postgresql-mcp": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "--rm",
        "-e",
        "POSTGRES_CONNECTION_STRING",
        "henkey/postgres-mcp:latest"
      ],
      "env": {
        "POSTGRES_CONNECTION_STRING": "postgresql://user:password@host:port/database"
      }
    }
  }
}
```

## Prerequisites

- Node.js ≥ 18.0.0 (for local development)
- Docker (for containerized deployment)
- PostgreSQL server access
- Valid connection credentials

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Create a Pull Request

See [Development Guide](./docs/DEVELOPMENT.md) for detailed setup instructions.

## License

AGPLv3 License - see [LICENSE](./LICENSE) file for details.
