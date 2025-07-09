# PostgreSQL MCP Server
[![smithery badge](https://smithery.ai/badge/@HenkDz/postgresql-mcp-server)](https://smithery.ai/server/@HenkDz/postgresql-mcp-server)

A Model Context Protocol (MCP) server that provides comprehensive PostgreSQL database management capabilities for AI assistants.

**🚀 What's New**: This server has been completely redesigned from 46 individual tools to 17 intelligent tools through consolidation (34→8 meta-tools) and enhancement (+4 new tools), providing better AI discovery while adding powerful data manipulation and comment management capabilities.

## Quick Start

[![Install MCP Server](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=postgresql-mcp&config=JTdCJTIyY29tbWFuZCUyMiUzQSUyMm5weCUyMCU0MGhlbmtleSUyRnBvc3RncmVzLW1jcC1zZXJ2ZXIlMjAtLWNvbm5lY3Rpb24tc3RyaW5nJTIwcG9zdGdyZXNxbCUzQSUyRiUyRnVzZXIlM0FwYXNzd29yZCU0MGhvc3QlM0Fwb3J0JTJGZGF0YWJhc2UlMjIlN0Q%3D)

### Option 1: npm (Recommended)
```bash
# Install globally
npm install -g @henkey/postgres-mcp-server

# Or run directly with npx (no installation)
npx @henkey/postgres-mcp-server --connection-string "postgresql://user:pass@localhost:5432/db"
```

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

### Option 3: Manual Installation (Development)
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

## What's Included

**17 powerful tools** organized into three categories:
- **🔄 Consolidation**: 34 original tools consolidated into 8 intelligent meta-tools
- **🔧 Specialized**: 5 tools kept separate for complex operations  
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

### 🔧 **Specialized Tools** (5 tools)
- **Database Analysis** - Performance and configuration analysis
- **Debug Database** - Troubleshoot connection, performance, locks
- **Data Export/Import** - JSON/CSV data migration
- **Copy Between Databases** - Cross-database data transfer  
- **Real-time Monitoring** - Live database metrics and alerts

## Example Usage

```typescript
// Analyze database performance
{ "analysisType": "performance" }

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

// Insert new data
{
  "operation": "insert",
  "table": "users",
  "data": {"name": "John Doe", "email": "john@example.com"},
  "returning": "*"
}

// Find slow queries
{
  "operation": "get_slow_queries",
  "limit": 5,
  "minDuration": 100
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

- **[📖 Usage Guide](./docs/USAGE.md)** - Comprehensive tool usage and examples
- **[🛠️ Development Guide](./docs/DEVELOPMENT.md)** - Setup and contribution guide  
- **[⚙️ Technical Details](./docs/TECHNICAL.md)** - Architecture and implementation
- **[👨‍💻 Developer Reference](./docs/DEVELOPER.md)** - API reference and advanced usage
- **[📋 Documentation Index](./docs/INDEX.md)** - Complete documentation overview

## Features Highlights

### **🔄 Consolidation Achievements**
✅ **34→8 meta-tools** - Intelligent consolidation for better AI discovery  
✅ **Multiple operations per tool** - Unified schemas with operation parameters  
✅ **Smart parameter validation** - Clear error messages and type safety

### **🆕 Enhanced Data Capabilities** 
✅ **Complete CRUD operations** - INSERT/UPDATE/DELETE/UPSERT with parameterized queries  
✅ **Flexible querying** - SELECT with count/exists support and safety limits
✅ **Arbitrary SQL execution** - Transaction support for complex operations

### **🔧 Production Ready**
✅ **Flexible connection** - CLI args, env vars, or per-tool configuration  
✅ **Security focused** - SQL injection prevention, parameterized queries  
✅ **Robust architecture** - Connection pooling, comprehensive error handling

## Prerequisites

- Node.js ≥ 18.0.0
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
