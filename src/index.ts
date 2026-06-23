#!/usr/bin/env node
import { program } from 'commander';
import fs from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Import tool types
import type { PostgresTool, ToolOutput } from './types/tool.js';
import { DatabaseConnection } from './utils/connection.js';

// Import all tool implementations
import { analyzeDatabaseTool } from './tools/analyze.js';
import { manageFunctionsTool, manageRLSTool } from './tools/functions.js';
import { debugDatabaseTool } from './tools/debug.js';
import { exportTableDataTool, importTableDataTool, copyBetweenDatabasesTool } from './tools/migration.js';
import { monitorDatabaseTool } from './tools/monitor.js';
import { manageSchemaTools } from './tools/schema.js';
import { manageTriggersTools } from './tools/triggers.js';
import { manageIndexesTool } from './tools/indexes.js';
import { manageQueryTool } from './tools/query.js';
import { manageUsersTool } from './tools/users.js';
import { manageConstraintsTool } from './tools/constraints.js';
import { executeQueryTool, executeMutationTool, executeSqlTool } from './tools/data.js';
import { manageCommentsTool } from './tools/comments.js';

// Initialize commander
program
  .version('1.0.7')
  .option('-cs, --connection-string <string>', 'PostgreSQL connection string')
  .option('-tc, --tools-config <path>', 'Path to tools configuration JSON file')
  .parse(process.argv);

const options = program.opts();

/**
 * Get connection string from various sources in order of precedence:
 * 1. Function argument (tool-specific)
 * 2. CLI --connection-string option
 * 3. POSTGRES_CONNECTION_STRING environment variable
 */
function getConnectionString(connectionStringArg?: string): string {
  if (connectionStringArg) {
    return connectionStringArg;
  }
  const cliConnectionString = options.connectionString;
  if (cliConnectionString) {
    return cliConnectionString;
  }
  const envConnectionString = process.env.POSTGRES_CONNECTION_STRING;
  if (envConnectionString) {
    return envConnectionString;
  }
  throw new McpError(
    ErrorCode.InvalidParams,
    'No connection string provided. Provide one in the tool arguments, via the --connection-string CLI option, or set the POSTGRES_CONNECTION_STRING environment variable.'
  );
}

class PostgreSQLServer {
  private server: Server;
  public availableToolsList: PostgresTool[];
  private enabledTools: PostgresTool[];
  private enabledToolsMap: Record<string, PostgresTool>;

  constructor(initialTools: PostgresTool[] = []) {
    this.availableToolsList = [...initialTools]; 
    this.enabledTools = [];
    this.enabledToolsMap = {};
    this.loadAndFilterTools();

    this.server = new Server(
      {
        name: 'postgresql-mcp-server',
        version: '1.0.7',
      },
      {
        capabilities: {
          tools: this.enabledTools.reduce((acc, tool) => {
            acc[tool.name] = {
              name: tool.name,
              description: tool.description,
              inputSchema: zodToJsonSchema(tool.inputSchema),
            };
            return acc;
          }, {} as Record<string, { name: string; description: string; inputSchema: object }>),
        },
      }
    );
    
    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  /**
   * Load tools configuration and filter enabled tools
   */
  private loadAndFilterTools(): void {
    let toolsToEnable = [...this.availableToolsList];
    const toolsConfigPath = options.toolsConfig;

    if (toolsConfigPath) {
      try {
        const configContent = fs.readFileSync(toolsConfigPath, 'utf-8');
        const config = JSON.parse(configContent);
        if (config && Array.isArray(config.enabledTools) && config.enabledTools.every((t: unknown) => typeof t === 'string')) {
          const enabledToolNames = new Set(config.enabledTools as string[]);
          toolsToEnable = this.availableToolsList.filter(tool => enabledToolNames.has(tool.name));
          console.error(`[MCP Info] Loaded tools configuration from ${toolsConfigPath}. Enabled tools: ${toolsToEnable.map(t => t.name).join(', ')}`);
          
          // Warn about tools specified in config but not available
          for (const requestedName of enabledToolNames) {
            if (!this.availableToolsList.some(tool => tool.name === requestedName)) {
              console.warn(`[MCP Warning] Tool "${requestedName}" specified in config file but not found in available tools.`);
            }
          }
        } else {
          console.error(`[MCP Warning] Invalid tools configuration file format at ${toolsConfigPath}.`);
        }
      } catch (error) {
        console.error(`[MCP Warning] Could not read or parse tools configuration file at ${toolsConfigPath}. Error: ${error instanceof Error ? error.message : String(error)}.`);
      }
    } else {
      if (this.availableToolsList.length > 0) {
        console.error('[MCP Info] No tools configuration file provided. All available tools will be enabled.');
      } else {
        console.error('[MCP Info] No tools configuration file provided and no tools loaded into availableToolsList.');
      }
    }
    
    this.enabledTools = toolsToEnable;
    this.enabledToolsMap = toolsToEnable.reduce((acc, tool) => {
      acc[tool.name] = tool;
      return acc;
    }, {} as Record<string, PostgresTool>);
  }

  /**
   * Clean up resources on shutdown
   */
  private async cleanup(): Promise<void> {
    console.error('Shutting down PostgreSQL MCP server...');
    await DatabaseConnection.cleanupPools();
    if (this.server) {
      await this.server.close();
    }
  }

  /**
   * Setup MCP request handlers
   */
  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.enabledTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema),
      })),
    }));

    // Handle tool execution requests
    // biome-ignore lint/suspicious/noExplicitAny: MCP SDK type inference issue
    this.server.setRequestHandler(CallToolRequestSchema, (async (request: any): Promise<ToolOutput> => {
      try {
        const toolName = request.params.name;
        const tool = this.enabledToolsMap[toolName];
        
        if (!tool) {
          const wasAvailable = this.availableToolsList.some(t => t.name === toolName);
          const message = wasAvailable 
            ? `Tool "${toolName}" is available but not enabled by the current server configuration.` 
            : `Tool '${toolName}' is not enabled or does not exist.`;
          throw new McpError(ErrorCode.MethodNotFound, message);
        }
        
        const result: ToolOutput = await tool.execute(request.params.arguments, getConnectionString);
        return result;
      } catch (error) {
        console.error(`Error handling request for tool ${request.params.name}:`, error);
        let errorMessage = error instanceof Error ? error.message : String(error);
        if (error instanceof McpError) {
            errorMessage = error.message;
        }
        return {
          content: [{ type: 'text', text: `Error: ${errorMessage}` }],
          isError: true,
        } as ToolOutput;
      }
    // biome-ignore lint/suspicious/noExplicitAny: MCP SDK type inference issue
    }) as any);
  }

  async run() {
    if (this.availableToolsList.length === 0 && !options.toolsConfig) {
        console.warn("[MCP Warning] No tools loaded and no tools config provided. Server will start with no active tools.");
    }
    
    this.loadAndFilterTools(); 
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('PostgreSQL MCP server running on stdio');
  }
}

/**
 * All available PostgreSQL MCP tools
 * Organized by category for maintainability
 */
const allTools: PostgresTool[] = [
  // Core Analysis & Debugging
  analyzeDatabaseTool,
  debugDatabaseTool,
  
  // Schema & Structure Management (Meta-Tools)
  manageSchemaTools,
  manageFunctionsTool,
  manageTriggersTools,
  manageIndexesTool,
  manageConstraintsTool,
  manageRLSTool,
  
  // User & Security Management
  manageUsersTool,
  
  // Query & Performance Management
  manageQueryTool,
  
  // Data Operations (Enhancement Tools)
  executeQueryTool,
  executeMutationTool,
  executeSqlTool,
  
  // Documentation & Metadata
  manageCommentsTool,
  
  // Data Migration & Monitoring
  exportTableDataTool,
  importTableDataTool,
  copyBetweenDatabasesTool,
  monitorDatabaseTool
];

const serverInstance = new PostgreSQLServer(allTools); 

serverInstance.run().catch(error => {
  console.error('Failed to run the server:', error);
  process.exit(1);
});
