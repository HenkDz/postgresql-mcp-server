# PostgreSQL MCP Server

A Model Context Protocol (MCP) server that provides PostgreSQL database management capabilities. This server assists with analyzing existing PostgreSQL setups, providing implementation guidance, and debugging database issues.

<a href="https://glama.ai/mcp/servers/@HenkDz/postgresql-mcp-server">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@HenkDz/postgresql-mcp-server/badge" alt="PostgreSQL Server MCP server" />
</a>

## Features

### 1. Database Analysis (`analyze_database`)
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

### 2. Setup Instructions (`get_setup_instructions`)
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

### 3. Database Debugging (`debug_database`)
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

## Prerequisites

- Node.js >= 18.0.0
- PostgreSQL server (for target database operations)
- Network access to target PostgreSQL instances

## Installation

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