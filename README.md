# PostgreSQL MCP Server
[![smithery badge](https://smithery.ai/badge/@HenkDz/postgresql-mcp-server)](https://smithery.ai/server/@HenkDz/postgresql-mcp-server)

A Model Context Protocol (MCP) server that provides PostgreSQL database management capabilities. This server assists with analyzing existing PostgreSQL setups, providing implementation guidance, debugging database issues, managing schemas, migrating data, and monitoring database performance.

## Features

### Database Analysis and Debugging

#### 1. Database Analysis (`analyze_database`)
Analyzes PostgreSQL database configuration and performance metrics:
- Configuration analysis
- Performance metrics
- Security assessment
- Recommendations for optimization

```typescript
// Example usage
{
  "connectionString": "postgresql://user:password@localhost:5432/dbname",
  "analysisType": "performance" // Optional: "configuration" | "performance" | "security"
}
```

#### 2. Setup Instructions (`get_setup_instructions`)
Provides step-by-step PostgreSQL installation and configuration guidance:
- Platform-specific installation steps
- Configuration recommendations
- Security best practices
- Post-installation tasks

```typescript
// Example usage
{
  "platform": "linux", // Required: "linux" | "macos" | "windows"
  "version": "15", // Optional: PostgreSQL version
  "useCase": "production" // Optional: "development" | "production"
}
```

#### 3. Database Debugging (`debug_database`)
Debug common PostgreSQL issues:
- Connection problems
- Performance bottlenecks
- Lock conflicts
- Replication status

```typescript
// Example usage
{
  "connectionString": "postgresql://user:password@localhost:5432/dbname",
  "issue": "performance", // Required: "connection" | "performance" | "locks" | "replication"
  "logLevel": "debug" // Optional: "info" | "debug" | "trace"
}
```

### Schema Management

#### 4. Schema Information (`get_schema_info`)
Get detailed schema information for a database or specific table:
- List of tables in a database
- Column definitions
- Constraints (primary keys, foreign keys, etc.)
- Indexes

```typescript
// Example usage
{
  "connectionString": "postgresql://user:password@localhost:5432/dbname",
  "tableName": "users" // Optional: specific table to get info for
}
```

#### 5. Create Table (`create_table`)
Create a new table with specified columns:
- Define column names and types
- Set nullable constraints
- Set default values

```typescript
// Example usage
{
  "connectionString": "postgresql://user:password@localhost:5432/dbname",
  "tableName": "users",
  "columns": [
    { "name": "id", "type": "SERIAL", "nullable": false },
    { "name": "username", "type": "VARCHAR(100)", "nullable": false },
    { "name": "email", "type": "VARCHAR(255)", "nullable": false },
    { "name": "created_at", "type": "TIMESTAMP", "default": "NOW()" }
  ]
}
```

#### 6. Alter Table (`alter_table`)
Modify existing tables:
- Add new columns
- Modify column types or constraints
- Drop columns

```typescript
// Example usage
{
  "connectionString": "postgresql://user:password@localhost:5432/dbname",
  "tableName": "users",
  "operations": [
    { "type": "add", "columnName": "last_login", "dataType": "TIMESTAMP" },
    { "type": "alter", "columnName": "email", "nullable": false },
    { "type": "drop", "columnName": "temporary_field" }
  ]
}
```

### Data Migration

#### 7. Export Table Data (`export_table_data`)
Export table data to JSON or CSV format:
- Filter data with WHERE clause
- Limit number of rows
- Choose output format

```typescript
// Example usage
{
  "connectionString": "postgresql://user:password@localhost:5432/dbname",
  "tableName": "users",
  "outputPath": "./exports/users.json",
  "where": "created_at > '2023-01-01'", // Optional
  "limit": 1000, // Optional
  "format": "json" // Optional: "json" | "csv"
}
```

#### 8. Import Table Data (`import_table_data`)
Import data from JSON or CSV files:
- Optionally truncate table before import
- Support for different formats
- Custom CSV delimiters

```typescript
// Example usage
{
  "connectionString": "postgresql://user:password@localhost:5432/dbname",
  "tableName": "users",
  "inputPath": "./imports/users.json",
  "truncateFirst": false, // Optional
  "format": "json", // Optional: "json" | "csv"
  "delimiter": "," // Optional: for CSV files
}
```

#### 9. Copy Between Databases (`copy_between_databases`)
Copy data between two PostgreSQL databases:
- Filter data with WHERE clause
- Optionally truncate target table

```typescript
// Example usage
{
  "sourceConnectionString": "postgresql://user:password@localhost:5432/source_db",
  "targetConnectionString": "postgresql://user:password@localhost:5432/target_db",
  "tableName": "users",
  "where": "active = true", // Optional
  "truncateTarget": false // Optional
}
```

### Monitoring

#### 10. Monitor Database (`monitor_database`)
Real-time monitoring of PostgreSQL database:
- Database metrics (connections, cache hit ratio, etc.)
- Table metrics (size, row counts, dead tuples)
- Active query information
- Lock information
- Replication status
- Configurable alerts

```typescript
// Example usage
{
  "connectionString": "postgresql://user:password@localhost:5432/dbname",
  "includeTables": true, // Optional
  "includeQueries": true, // Optional
  "includeLocks": true, // Optional
  "includeReplication": false, // Optional
  "alertThresholds": { // Optional
    "connectionPercentage": 80,
    "longRunningQuerySeconds": 30,
    "cacheHitRatio": 0.95,
    "deadTuplesPercentage": 10,
    "vacuumAge": 7
  }
}
```

## Prerequisites

- Node.js >= 18.0.0
- PostgreSQL server (for target database operations)
- Network access to target PostgreSQL instances

## Installation

### Installing via Smithery

To install postgresql-mcp-server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@HenkDz/postgresql-mcp-server):

```bash
npx -y @smithery/cli install @HenkDz/postgresql-mcp-server --client claude
```

### Manual Installation
1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the server:
   ```bash
   npm run build
   ```
4. Add to MCP settings file:
   ```json
   {
     "mcpServers": {
       "postgresql-mcp": {
         "command": "node",
         "args": ["/path/to/postgresql-mcp-server/build/index.js"],
         "disabled": false,
         "alwaysAllow": []
       }
     }
   }
   ```

## Development

- `npm run dev` - Start development server with hot reload
- `npm run lint` - Run ESLint
- `npm test` - Run tests

## Security Considerations

1. Connection Security
   - Uses connection pooling
   - Implements connection timeouts
   - Validates connection strings
   - Supports SSL/TLS connections

2. Query Safety
   - Validates SQL queries
   - Prevents dangerous operations
   - Implements query timeouts
   - Logs all operations

3. Authentication
   - Supports multiple authentication methods
   - Implements role-based access control
   - Enforces password policies
   - Manages connection credentials securely

## Best Practices

1. Always use secure connection strings with proper credentials
2. Follow production security recommendations for sensitive environments
3. Regularly monitor and analyze database performance
4. Keep PostgreSQL version up to date
5. Implement proper backup strategies
6. Use connection pooling for better resource management
7. Implement proper error handling and logging
8. Regular security audits and updates

## Error Handling

The server implements comprehensive error handling:
- Connection failures
- Query timeouts
- Authentication errors
- Permission issues
- Resource constraints

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## License

This project is licensed under the AGPLv3 License - see LICENSE file for details.
