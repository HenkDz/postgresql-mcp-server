# PostgreSQL MCP Server - Complete Tool Schema Reference

> **Quick Reference**: This document contains the complete parameter schemas for all 18 tools. No more hunting through multiple docs!

## 🚀 Quick Navigation

| Category | Tools |
|----------|-------|
| [**Meta-Tools**](#meta-tools-consolidated-operations) | [Schema](#schema-management) • [Users](#user--permissions-management) • [Query](#query-performance--analysis) • [Index](#index-management) • [Functions](#functions-management) • [Triggers](#triggers-management) • [Constraints](#constraint-management) • [RLS](#row-level-security-rls) |
| [**🆕 Enhancement Tools**](#enhancement-tools-new-capabilities) | [Execute Query](#execute-query) • [Execute Mutation](#execute-mutation) • [Execute SQL](#execute-sql) • [Comments](#comments-management) |
| [**Specialized**](#specialized-tools) | [Analysis](#database-analysis) • [Debug](#database-debugging) • [Export/Import](#data-exportimport) • [Copy](#copy-between-databases) • [Monitor](#real-time-monitoring) |

---

## Meta-Tools (Consolidated Operations)

### Schema Management
**Tool:** `pg_manage_schema`

#### Get Schema Information
```json
{
  "operation": "get_info",
  "schema": "public",           // optional, defaults to "public"
  "tableName": "users"          // optional, omit to list all tables
}
```

#### Create Table
```json
{
  "operation": "create_table",
  "tableName": "users",         // required
  "schema": "public",           // optional, defaults to "public"
  "columns": [                  // required
    {
      "name": "id",             // required
      "type": "SERIAL",         // required: PostgreSQL data type
      "nullable": false,        // optional, defaults to true
      "default": "DEFAULT_VALUE" // optional raw SQL expression; requires unsafe mode
    }
  ]
}
```

Table, schema, enum, and column names are restricted to simple PostgreSQL identifiers and quoted by the server. Column `type` accepts simple PostgreSQL type names such as `text`, `integer`, `numeric(10,2)`, `timestamp with time zone`, or `schema.type`. Column `default` is a raw SQL expression and requires `--security-mode unsafe --allow-destructive`.

#### Alter Table
```json
{
  "operation": "alter_table",
  "tableName": "users",         // required
  "schema": "public",           // optional
  "operations": [               // required
    {
      "type": "add",            // required: "add" | "alter" | "drop"
      "columnName": "email",    // required
      "dataType": "VARCHAR(255)", // required for add/alter
      "nullable": false,        // optional for add/alter
      "default": "DEFAULT_VALUE" // optional raw SQL expression; requires unsafe mode
    }
  ]
}
```

#### Get ENUMs
```json
{
  "operation": "get_enums",
  "schema": "public",           // optional
  "enumName": "user_role"       // optional, filter by specific enum
}
```

#### Create ENUM
```json
{
  "operation": "create_enum",
  "enumName": "status",         // required
  "values": ["active", "inactive"], // required
  "schema": "public",           // optional
  "ifNotExists": true           // optional
}
```

---

### User & Permissions Management
**Tool:** `pg_manage_users`

#### Create User
```json
{
  "operation": "create",
  "username": "newuser",        // required
  "password": "securepass",     // required
  "login": true,                // optional
  "createdb": false,            // optional
  "createrole": false,          // optional
  "superuser": false,           // optional
  "replication": false,         // optional
  "inherit": true,              // optional
  "connectionLimit": 10,        // optional: -1 for unlimited
  "validUntil": "2024-12-31"    // optional: YYYY-MM-DD
}
```

#### Grant Permissions
```json
{
  "operation": "grant",
  "username": "testuser",       // required
  "permissions": ["SELECT", "INSERT"], // required: non-empty array of permissions
  "target": "users",            // required: object name
  "targetType": "table",        // required: "table" | "schema" | "database" | "sequence" | "function"
  "schema": "public",           // optional
  "withGrantOption": false      // optional
}
```

Role, schema, database, table, sequence, and function names are validated as simple PostgreSQL identifiers and then quoted. For `targetType: "function"`, provide the function name only; overloaded function signatures are not accepted by this safe grant/revoke path.

Creating or altering a role with `superuser`, `createdb`, `createrole`, or `replication` set to `true` requires `--allow-destructive` in addition to `--security-mode admin`. Grants that include `ALL`, `TRUNCATE`, or `withGrantOption: true` also require destructive opt-in because they broaden or delegate future database permissions.

#### Other User Operations
```json
// List users
{ "operation": "list", "includeSystemRoles": false }

// Drop user  
{ "operation": "drop", "username": "olduser", "ifExists": true, "cascade": false }

// Alter user
{ "operation": "alter", "username": "user", "password": "newpass", "login": false }

// Revoke permissions
{ "operation": "revoke", "username": "user", "permissions": ["DELETE"], "target": "table", "targetType": "table" }

// Get user permissions
{ "operation": "get_permissions", "username": "user", "schema": "public" }
```

---

### Query Performance & Analysis  
**Tool:** `pg_manage_query`

#### EXPLAIN Query
```json
{
  "operation": "explain",
  "query": "SELECT * FROM users WHERE email = $1", // required
  "analyze": false,             // optional: actually execute query
  "verbose": false,             // optional: include verbose output
  "costs": true,                // optional: include cost estimates
  "buffers": false,             // optional: include buffer usage
  "format": "json"              // optional: "text" | "json" | "xml" | "yaml"
}
```

`explain` accepts one read-only `SELECT`, `WITH`, `VALUES`, or `TABLE` statement without semicolons and runs the EXPLAIN inside a read-only transaction. `analyze: true` runs `EXPLAIN ANALYZE`, which executes the supplied query and therefore requires `--security-mode unsafe --allow-destructive`.

#### Get Slow Queries
```json
{
  "operation": "get_slow_queries",
  "limit": 10,                  // optional, defaults to 10, max 100
  "minDuration": 100,           // optional: minimum avg duration in ms
  "orderBy": "mean_time",       // optional: "mean_time" | "total_time" | "calls" | "cache_hit_ratio"
  "includeNormalized": true     // optional: include normalized query text
}
```

#### Other Query Operations
```json
// Get query statistics
{ "operation": "get_stats", "queryPattern": "SELECT", "minCalls": 5, "orderBy": "mean_time" }

// Reset query statistics
{ "operation": "reset_stats", "queryId": "12345" } // queryId optional, resets all if omitted
```

`reset_stats` changes `pg_stat_statements` state and is treated as destructive. `queryId` must be a numeric pg_stat_statements query ID.

---

### Index Management
**Tool:** `pg_manage_indexes`

#### Create Index
```json
{
  "operation": "create",
  "indexName": "idx_users_email", // required
  "tableName": "users",         // required
  "columns": ["email"],         // required: array of column names
  "schema": "public",           // optional
  "unique": false,              // optional
  "concurrent": false,          // optional: create concurrently
  "method": "btree",            // optional: "btree" | "hash" | "gist" | "spgist" | "gin" | "brin"
  "where": {                    // optional: structured partial index predicate
    "email": { "isNull": false },
    "active": true
  },
  "ifNotExists": false          // optional
}
```

Partial-index `where` supports the same structured operators as mutation filters. Legacy string `where` clauses are rejected. Use `rawWhere` only for trusted local/admin partial-index predicates; it is classified as arbitrary SQL and requires `--security-mode unsafe --allow-destructive`.

#### Other Index Operations
```json
// List indexes
{ "operation": "get", "tableName": "users", "includeStats": true }

// Drop index
{ "operation": "drop", "indexName": "old_idx", "concurrent": false, "ifExists": true, "cascade": false }

// Reindex
{ "operation": "reindex", "type": "index", "target": "idx_name" } // type: "index" | "table" | "schema" | "database"

// Analyze index usage
{ "operation": "analyze_usage", "showUnused": true, "showDuplicates": true, "minSizeBytes": 1000 }
```

---

### Functions Management
**Tool:** `pg_manage_functions`

#### Create Function
```json
{
  "operation": "create",
  "functionName": "calculate_total", // required
  "parameters": "price DECIMAL, tax DECIMAL", // required (use "" for no params)
  "returnType": "DECIMAL",          // required
  "functionBody": "BEGIN RETURN price + (price * tax); END;", // required
  "language": "plpgsql",            // optional: "sql" | "plpgsql" | "plpython3u"
  "schema": "public",               // optional
  "replace": false,                 // optional: CREATE OR REPLACE
  "volatility": "VOLATILE",         // optional: "VOLATILE" | "STABLE" | "IMMUTABLE"
  "security": "INVOKER"             // optional: "INVOKER" | "DEFINER"
}
```

#### Other Function Operations
```json
// List functions
{ "operation": "get", "functionName": "calc%", "schema": "public" } // functionName optional for filtering

// Drop function
{ "operation": "drop", "functionName": "old_func", "parameters": "INT, TEXT", "ifExists": true, "cascade": false }
```

Function names are restricted to simple PostgreSQL identifiers and quoted by the server. Function `parameters`, `returnType`, and `functionBody` are raw SQL/code inputs; creating functions is classified as arbitrary SQL and requires `--security-mode unsafe --allow-destructive`. Drop signatures accept only comma-separated simple type names.

---

### Triggers Management
**Tool:** `pg_manage_triggers`

#### Create Trigger
```json
{
  "operation": "create",
  "triggerName": "audit_trigger",  // required
  "tableName": "users",            // required
  "functionName": "audit_function", // required
  "timing": "AFTER",               // optional: "BEFORE" | "AFTER" | "INSTEAD OF"
  "events": ["INSERT", "UPDATE"],  // optional: non-empty array of "INSERT" | "UPDATE" | "DELETE" | "TRUNCATE"
  "forEach": "ROW",                // optional: "ROW" | "STATEMENT"
  "when": "NEW.active = true",     // optional: raw WHEN condition; requires unsafe mode
  "schema": "public",              // optional
  "replace": false                 // optional
}
```

Trigger, table, and function names are restricted to simple PostgreSQL identifiers and quoted by the server. Trigger `when` is a raw SQL expression; using it is classified as arbitrary SQL and requires `--security-mode unsafe --allow-destructive`.

#### Other Trigger Operations
```json
// List triggers
{ "operation": "get", "tableName": "users", "schema": "public" }

// Drop trigger
{ "operation": "drop", "triggerName": "old_trigger", "tableName": "users", "ifExists": true, "cascade": false }

// Enable/disable trigger
{ "operation": "set_state", "triggerName": "my_trigger", "tableName": "users", "enable": true }
```

---

### Constraint Management
**Tool:** `pg_manage_constraints`

#### Create Foreign Key
```json
{
  "operation": "create_fk",
  "constraintName": "fk_user_id",   // required
  "tableName": "orders",            // required
  "columnNames": ["user_id"],       // required: non-empty
  "referencedTable": "users",       // required
  "referencedColumns": ["id"],      // required: non-empty
  "schema": "public",               // optional
  "referencedSchema": "public",     // optional
  "onDelete": "CASCADE",            // optional: "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT"
  "onUpdate": "NO ACTION",          // optional
  "deferrable": false,              // optional
  "initiallyDeferred": false        // optional
}
```

#### Create Other Constraints
```json
{
  "operation": "create",
  "constraintName": "unique_email", // required
  "tableName": "users",            // required
  "constraintTypeCreate": "unique", // required: "unique" | "check" | "primary_key"
  "columnNames": ["email"],        // required and non-empty for unique/primary_key
  "schema": "public"               // optional
}
```

`checkExpression` is raw SQL by nature and is therefore treated as unsafe by the server policy. Creating CHECK constraints requires `--security-mode unsafe --allow-destructive`.

#### Other Constraint Operations
```json
// List constraints
{ "operation": "get", "tableName": "users", "constraintType": "FOREIGN KEY" }

// Drop constraint
{ "operation": "drop", "constraintName": "old_constraint", "tableName": "users", "ifExists": true, "cascade": false }

// Drop foreign key
{ "operation": "drop_fk", "constraintName": "fk_old", "tableName": "orders", "ifExists": true, "cascade": false }
```

---

### Row-Level Security (RLS)
**Tool:** `pg_manage_rls`

#### Enable/Disable RLS
```json
// Enable RLS
{ "operation": "enable", "tableName": "users", "schema": "public" }

// Disable RLS  
{ "operation": "disable", "tableName": "users", "schema": "public" }
```

#### Create RLS Policy
```json
{
  "operation": "create_policy",
  "tableName": "users",            // required
  "policyName": "user_isolation",  // required
  "using": "user_id = current_user_id()", // required: USING expression
  "check": "user_id = current_user_id()", // optional: WITH CHECK expression
  "command": "ALL",                // optional: "ALL" | "SELECT" | "INSERT" | "UPDATE" | "DELETE"
  "role": "authenticated",         // optional: role name
  "schema": "public",              // optional
  "replace": false                 // optional
}
```

Policy, table, and role names are restricted to simple PostgreSQL identifiers and quoted by the server. RLS `using` and `check` are raw SQL policy expressions; creating policies or editing those expressions is classified as arbitrary SQL and requires `--security-mode unsafe --allow-destructive`.

#### Other RLS Operations
```json
// List policies
{ "operation": "get_policies", "tableName": "users", "schema": "public" }

// Edit policy
{ "operation": "edit_policy", "policyName": "policy1", "tableName": "users", "using": "new_condition", "roles": ["role1", "role2"] }

// Drop policy  
{ "operation": "drop_policy", "policyName": "old_policy", "tableName": "users", "ifExists": true }
```

---

## Enhancement Tools (New Capabilities)

### Execute Query
**Tool:** `pg_execute_query`  
*For SELECT operations with advanced features*

#### Basic SELECT
```json
{
  "operation": "select",
  "query": "SELECT * FROM users WHERE active = $1", // required: SELECT query
  "parameters": [true],         // optional: parameters for $1, $2, etc.
  "limit": 100,                 // optional: select row limit, default 100, max 1000
  "timeout": 30000,             // optional: query timeout in ms
  "connectionString": "postgresql://..." // optional if env var set
}
```

`select` operations are wrapped in a bounded outer query and always receive a row limit. `count` and `exists` evaluate the provided SELECT without applying the select row limit.

#### Count Rows
```json
{
  "operation": "count",
  "query": "SELECT COUNT(*) FROM users WHERE created_at > $1",
  "parameters": ["2024-01-01"],
  "timeout": 10000
}
```

#### Check Existence
```json
{
  "operation": "exists",
  "query": "SELECT 1 FROM users WHERE email = $1",
  "parameters": ["user@example.com"]
}
```

---

### Execute Mutation
**Tool:** `pg_execute_mutation`  
*For INSERT/UPDATE/DELETE/UPSERT operations*

#### Insert Data
```json
{
  "operation": "insert",
  "table": "users",             // required: table name
  "data": {                     // required: data object
    "name": "John Doe",
    "email": "john@example.com",
    "active": true
  },
  "schema": "public",           // optional: defaults to "public"
  "returning": "*",             // optional: RETURNING clause
  "maxReturningRows": 100,      // optional: RETURNING rows in response, default 100, max 1000
  "connectionString": "postgresql://..." // optional if env var set
}
```

#### Update Data
```json
{
  "operation": "update",
  "table": "users",             // required
  "data": {                     // required: fields to update
    "name": "Jane Doe",
    "updated_at": "NOW()"
  },
  "where": { "id": 123 },       // required: structured WHERE predicate
  "schema": "public",           // optional
  "returning": ["id", "name", "updated_at"], // optional
  "maxReturningRows": 100       // optional: response output cap
}
```

#### Delete Data
```json
{
  "operation": "delete",
  "table": "users",             // required
  "where": {
    "active": false,
    "last_login": { "lt": "2023-01-01" }
  },
  "schema": "public"            // optional
}
```

#### Structured WHERE Predicates
```json
{
  "where": {
    "id": 123,
    "status": { "in": ["active", "pending"] },
    "created_at": { "gte": "2024-01-01" },
    "deleted_at": { "isNull": true }
  }
}
```

Supported operators: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `like`, `ilike`, `in`, and `isNull`.

Legacy string `where` clauses are rejected. Use `rawWhere` only for trusted local/admin filters; it is treated as an unsafe SQL fragment by the server security policy and requires `--security-mode unsafe --allow-destructive`.

#### Upsert (INSERT ... ON CONFLICT)
```json
{
  "operation": "upsert",
  "table": "users",             // required
  "data": {                     // required: data to insert/update
    "email": "user@example.com",
    "name": "Updated Name",
    "last_seen": "NOW()"
  },
  "conflictColumns": ["email"], // required: columns for ON CONFLICT
  "returning": "*",             // optional
  "maxReturningRows": 100       // optional: response output cap
}
```

`maxReturningRows` limits only the MCP response payload. The database mutation still runs normally, and `Rows affected` reports PostgreSQL `rowCount`.

---

### Execute SQL
**Tool:** `pg_execute_sql`  
*For arbitrary SQL with advanced features*

#### Simple SQL Statement
```json
{
  "sql": "CREATE INDEX CONCURRENTLY idx_users_email ON users(email)", // required
  "expectRows": false,          // optional: whether to expect rows back
  "timeout": 60000,             // optional: timeout in ms
  "maxRows": 100,               // optional: result rows in response, default 100, max 1000
  "transactional": false,       // optional: wrap in transaction
  "connectionString": "postgresql://..." // optional if env var set
}
```

#### Complex Query with Parameters
```json
{
  "sql": "WITH recent_users AS (SELECT * FROM users WHERE created_at > $1) SELECT COUNT(*) FROM recent_users",
  "parameters": ["2024-01-01"], // optional: parameters for $1, $2, etc.
  "expectRows": true,
  "timeout": 30000,
  "maxRows": 100
}
```

`maxRows` limits only the rows included in the MCP response. It does not rewrite arbitrary SQL or reduce database work.

Multi-statement arbitrary SQL must use `transactional: true`, `expectRows: false`, and no `parameters`. Use a single parameterized statement, for example a CTE, when bind parameters are needed.

#### Transactional Operation
```json
{
  "sql": "WITH debit AS (UPDATE accounts SET balance = balance - $1 WHERE id = $2 RETURNING id) UPDATE accounts SET balance = balance + $1 WHERE id = $3",
  "parameters": [100, 1, 2],
  "transactional": true,        // wraps in BEGIN/COMMIT
  "expectRows": false
}
```

#### Data Definition (DDL)
```json
{
  "sql": "ALTER TABLE users ADD COLUMN phone VARCHAR(20); CREATE INDEX idx_users_phone ON users(phone);",
  "expectRows": false,
  "transactional": true
}
```

---

### Comments Management
**Tool:** `pg_manage_comments`  
*Comprehensive comment management for all database objects*

#### Get Comment
```json
{
  "operation": "get",
  "objectType": "table",        // required: "table" | "column" | "index" | "constraint" | "function" | "trigger" | "view" | "sequence" | "schema" | "database"
  "objectName": "users",        // required: object name
  "schema": "public",           // required for most object types (defaults to "public")
  "columnName": "email",        // required when objectType is "column"
  "connectionString": "postgresql://..." // optional if env var set
}
```

#### Set Comment
```json
{
  "operation": "set",
  "objectType": "table",        // required
  "objectName": "users",        // required
  "comment": "Main user account information table", // required
  "schema": "public",           // optional, defaults to "public"
  "columnName": "created_at",   // required when objectType is "column"
  "tableName": "users",         // required when objectType is "constraint" or "trigger"
  "functionSignature": ""       // optional for function comments; use "" for no arguments
}
```

Comment targets are restricted to simple PostgreSQL identifiers and quoted by the server. Comment text is escaped as a SQL literal. Function comment signatures accept only comma-separated simple type names.

#### Remove Comment
```json
{
  "operation": "remove",
  "objectType": "column",       // required
  "objectName": "users",        // required
  "columnName": "old_field",    // required for column type
  "schema": "public"            // optional
}
```

#### Bulk Get (Discovery Mode)
```json
{
  "operation": "bulk_get",
  "schema": "public",           // optional: schema to search
  "filterObjectType": "table",  // optional: filter by object type
  "includeSystemObjects": false // optional: include system objects (defaults to false)
}
```

#### Supported Object Types
- **`table`** - Table comments
- **`column`** - Column comments (requires `columnName`)
- **`index`** - Index comments
- **`constraint`** - Constraint comments
- **`function`** - Function comments
- **`trigger`** - Trigger comments
- **`view`** - View comments
- **`sequence`** - Sequence comments
- **`schema`** - Schema comments
- **`database`** - Database comments

#### Examples by Object Type
```json
// Table comment
{ "operation": "set", "objectType": "table", "objectName": "orders", "comment": "Customer order records" }

// Column comment
{ "operation": "set", "objectType": "column", "objectName": "orders", "columnName": "total_amount", "comment": "Order total in USD" }

// Index comment
{ "operation": "set", "objectType": "index", "objectName": "idx_orders_date", "comment": "Index for date-range queries" }

// Function comment
{ "operation": "set", "objectType": "function", "objectName": "calculate_tax", "comment": "Calculates tax based on location" }

// Discover all commented objects
{ "operation": "bulk_get", "schema": "public", "includeSystemObjects": false }
```

---

## Specialized Tools

### Database Analysis
**Tool:** `pg_analyze_database`

```json
{
  "analysisType": "performance",   // optional, defaults to "configuration": "configuration" | "performance" | "security"
  "schema": "public",              // optional, defaults to "public"; schema to inspect for table-size diagnostics
  "connectionString": "postgresql://..." // optional if env var set
}
```

---

### Database Debugging
**Tool:** `pg_debug_database`

```json
{
  "issue": "performance",         // required: "connection" | "performance" | "locks" | "replication"
  "logLevel": "info",             // optional: "info" | "debug" | "trace"
  "connectionString": "postgresql://..." // optional if env var set
}
```

---

### Data Export/Import
**Tool:** `pg_export_table_data` | `pg_import_table_data`

#### Export
```json
{
  "tableName": "users",           // required
  "schema": "public",             // optional, defaults to "public"
  "outputPath": "exports/users.json", // required: path under POSTGRES_MCP_WORKSPACE_DIR
  "format": "json",               // optional: "json" | "csv"
  "limit": 1000,                  // optional: export row limit, default 1000, max 100000
  "where": { "active": true },    // optional: structured filter
  "connectionString": "postgresql://..." // optional
}
```

#### Import
```json
{
  "tableName": "users",           // required
  "schema": "public",             // optional, defaults to "public"
  "inputPath": "imports/users.json", // required: path under POSTGRES_MCP_WORKSPACE_DIR
  "format": "json",               // optional: "json" | "csv"
  "delimiter": ",",               // optional: for CSV
  "truncateFirst": false,         // optional: clear table first
  "connectionString": "postgresql://..." // optional
}
```

---

### Copy Between Databases
**Tool:** `pg_copy_between_databases`

This tool necessarily takes `sourceConnectionString` and `targetConnectionString`; the server must be started with `--allow-tool-connection-string` or `POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING=true` for those per-tool connection arguments to be accepted.

```json
{
  "sourceConnectionString": "postgresql://source...", // required
  "targetConnectionString": "postgresql://target...", // required
  "tableName": "users",           // required
  "schema": "public",             // optional, defaults to "public"; used for both source and target
  "where": { "created_at": { "gt": "2024-01-01" } }, // optional structured filter
  "limit": 1000,                  // optional: copied row limit, default 1000, max 100000
  "truncateTarget": false         // optional: clear target table first
}
```

Export/import paths are sandboxed to `POSTGRES_MCP_WORKSPACE_DIR` or `--workspace-dir`, must use `.json` or `.csv`, and are limited by `POSTGRES_MCP_MAX_FILE_BYTES` or `--max-file-bytes` (default: 10485760). JSON imports must be arrays of objects. Exports and copy-between-databases always use row limits (default: 1000, max: 100000). Legacy string `where` clauses are rejected. Use `rawWhere` only for trusted local/admin filters; it is classified as arbitrary SQL and requires `--security-mode unsafe --allow-destructive`.

---

### Real-time Monitoring
**Tool:** `pg_monitor_database`

```json
{
  "connectionString": "postgresql://...", // optional if env var set
  "includeQueries": true,         // optional: include active queries
  "includeLocks": false,          // optional: include lock information
  "includeTables": true,          // optional: include table statistics
  "includeReplication": false,    // optional: include replication status
  "alertThresholds": {            // optional: alert configuration
    "connectionPercentage": 80,   // optional: 0-100
    "cacheHitRatio": 0.95,        // optional: 0-1
    "longRunningQuerySeconds": 300, // optional: seconds
    "deadTuplesPercentage": 10,   // optional: 0-100
    "vacuumAge": 7                // optional: days
  }
}
```

---

## Connection String Format

All tools support PostgreSQL connection strings in this format:

```
postgresql://[user[:password]@][host][:port][/dbname][?param1=value1&...]
```

**Examples:**
```bash
# Basic
postgresql://user:pass@localhost:5432/mydb

# With SSL
postgresql://user:pass@localhost:5432/mydb?sslmode=require

# With connection pooling
postgresql://user:pass@localhost:5432/mydb?application_name=mcp-server&connect_timeout=10
```

**Environment Variable:** `POSTGRES_CONNECTION_STRING`

Per-tool connection string arguments are visible in schemas for compatibility, but the server rejects them by default. Enable them only for trusted local/admin workflows with `--allow-tool-connection-string` or `POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING=true`.
Explicit per-tool, CLI, and `POSTGRES_CONNECTION_STRING` values must be non-empty strings. Blank higher-priority connection strings fail validation instead of falling back to lower-priority sources.
Connection target allowlists can be configured with repeated `--allowed-connection-target`, the tools config `allowedConnectionTargets` array, or comma-separated `POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS`. Patterns use `[user@]host[:port][/database]`; omitted fields are unconstrained and `*` is accepted only as a full-field wildcard.

---

## Common Parameter Patterns

### Optional vs Required
- ✅ **Required parameters** will cause an error if omitted
- 🔄 **Optional parameters** have sensible defaults or can be omitted

### Schema Names
- Most tools default to `"public"` schema if not specified
- Always specify schema for non-public schemas

### IF EXISTS / IF NOT EXISTS
- Use `ifExists: true` for safer DROP operations
- Use `ifNotExists: true` for safer CREATE operations

### Parameterized Queries (Enhancement Tools)
- Use `$1`, `$2`, etc. placeholders in SQL queries
- Provide corresponding values in the `parameters` array
- This prevents SQL injection attacks

### Security Policy Defaults
- The server defaults to `readonly` mode.
- Mutations require `--security-mode write` or higher.
- DDL, role, RLS, filesystem import/export, and migration-style tools require `--security-mode admin` or higher.
- Arbitrary SQL through `pg_execute_sql` requires `--security-mode unsafe`.
- Destructive operations such as drops, resets, and arbitrary SQL also require `--allow-destructive`.
- Per-tool connection string arguments are disabled unless `--allow-tool-connection-string` or `POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING=true` is set.
- Connection target allowlists apply to both server-level and per-tool connection strings before database access.
- Security-boundary denials emit sanitized `[MCP Audit]` JSON lines on stderr without raw SQL, full request payloads, or connection-string passwords.
- Default runtime timeouts can be configured with `--statement-timeout-ms`, `--query-timeout-ms`, `POSTGRES_MCP_STATEMENT_TIMEOUT_MS`, `POSTGRES_MCP_QUERY_TIMEOUT_MS`, or the tools config keys `statementTimeoutMs` and `queryTimeoutMs`.

### Pagination & Safety Limits
- Query tools support `limit` parameter for safety (default varies)
- Meta-tools that return lists often support pagination
- Data mutation tools validate input for safety

### Transactions (Execute SQL)
- Set `transactional: true` for operations requiring ACID properties
- Useful for multi-statement operations or critical data changes

---

## Error Handling

MCP tool calls return text content with `isError: true` for validation, policy, connection, and database failures. Error messages are sanitized before they cross the server boundary: credentials, SQL literals, and sensitive diagnostic SQL text are redacted where possible.

Common failure categories:
- Input validation failures, including missing required fields and unknown fields
- Security policy denials, such as write tools in `readonly` mode or arbitrary SQL without `unsafe` mode
- Connection resolution and database connection failures
- PostgreSQL syntax, permission, timeout, transaction, and constraint failures

---

*Need more examples? Check the [examples/](./examples/) directory for complete working scenarios.*
