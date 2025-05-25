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

// Import the new tool types
import type { PostgresTool, ToolOutput } from './types/tool.js';

// Tool implementations will be imported here later
// For now, we'll define an empty list.
// e.g. import { analyzeDatabaseTool } from './tools/analyze.js';
// import { getSetupInstructionsTool } from './tools/setup.js';
// ... and so on for all tools

import { DatabaseConnection } from './utils/connection.js';

// Import the refactored tool
import { analyzeDatabaseTool } from './tools/analyze.js'; // .js because TS will compile to JS

// Import all refactored tools from functions.ts and add them to the allTools array.
// Commented out for testing consolidated functions tool
/*
import {
    getFunctionsTool,
    createFunctionTool,
    dropFunctionTool,
    enableRLSTool,
    disableRLSTool,
    createRLSPolicyTool,
    dropRLSPolicyTool,
    editRLSPolicyTool,
    getRLSPoliciesTool
} from './tools/functions.js'; // .js because TS will compile to JS
*/

// Import consolidated functions tool (for testing)
import {
    manageFunctionsTool,  // Now implemented
    // Commented out for RLS consolidation testing
    /*
    enableRLSTool,
    disableRLSTool,
    createRLSPolicyTool,
    dropRLSPolicyTool,
    editRLSPolicyTool,
    getRLSPoliciesTool
    */
    // New consolidated RLS tool
    manageRLSTool
} from './tools/functions.js';

// Import debug tool
import { debugDatabaseTool } from './tools/debug.js';

// Import enum tools
// Commented out for schema management consolidation
/*
import { getEnumsTool, createEnumTool } from './tools/enums.js';
*/
// Enums now included in consolidated schema tool

// Import migration tools
import { exportTableDataTool, importTableDataTool, copyBetweenDatabasesTool } from './tools/migration.js';

// Import monitor tool
import { monitorDatabaseTool } from './tools/monitor.js';

// Import schema tools
// Commented out for schema management consolidation
/*
import { getSchemaInfoTool, createTableTool, alterTableTool } from './tools/schema.js';
*/
// New consolidated schema management tool
import { manageSchemaTools } from './tools/schema.js';

// Import setup tool
import { getSetupInstructionsTool } from './tools/setup.js';

// Import trigger tools
// Import trigger tools
// Commented out for trigger management consolidation
/*
import { getTriggersTool, createTriggerTool, dropTriggerTool, setTriggerStateTool } from './tools/triggers.js';
*/
// New consolidated trigger management tool
import { manageTriggersTools } from './tools/triggers.js';

// Import index tools
// Commented out for index management consolidation
/*
import { getIndexesTool, createIndexTool, dropIndexTool, reindexTool, analyzeIndexUsageTool } from './tools/indexes.js';
*/
// New consolidated index management tool
import { manageIndexesTool } from './tools/indexes.js';

// Import performance tools
// Commented out for query management consolidation
/*
import { explainQueryTool, getSlowQueriesTool, getQueryStatsTool, resetQueryStatsTool } from './tools/performance.js';
*/
// New consolidated query management tool
import { manageQueryTool } from './tools/query.js';

// Import user management tools
// Commented out for user management consolidation
/*
import { createUserTool, dropUserTool, alterUserTool, grantPermissionsTool, revokePermissionsTool, getUserPermissionsTool, listUsersTool } from './tools/users.js';
*/
// New consolidated user management tool
import { manageUsersTool } from './tools/users.js';

// Import constraint tools
// Commented out for constraint management consolidation
/*
import { getConstraintsTool, createForeignKeyTool, dropForeignKeyTool, createConstraintTool, dropConstraintTool } from './tools/constraints.js';
*/
// New consolidated constraint management tool
import { manageConstraintsTool } from './tools/constraints.js';

// Import data query and mutation tools
import { executeQueryTool, executeMutationTool, executeSqlTool } from './tools/data.js';

// Initialize commander
program
  .version('1.0.4')
  .option('-cs, --connection-string <string>', 'PostgreSQL connection string')
  .option('-tc, --tools-config <path>', 'Path to tools configuration JSON file')
  .parse(process.argv);

const options = program.opts();

// Helper function to get connection string (remains largely the same)
// This function will be passed to each tool's execute method.
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

// TOOL_DEFINITIONS array is removed.
// Individual tool objects (PostgresTool) will be imported and collected.

class PostgreSQLServer {
  private server: Server;
  public availableToolsList: PostgresTool[]; // Made public for stepwise refactor
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
        version: '1.0.4',
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
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

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
    // Ensured no server.updateCapabilities() call here.
  }

  private async cleanup(): Promise<void> {
    console.error('Shutting down PostgreSQL MCP server...');
    await DatabaseConnection.cleanupPools();
    if (this.server) {
      await this.server.close();
    }
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.enabledTools.map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: zodToJsonSchema(tool.inputSchema),
      })),
    }));

    // Casting the handler to 'any' to bypass persistent incorrect type inference by TypeScript for this specific SDK call.
    // The actual returned structure (ToolOutput) is compliant with CallToolResponse.
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
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
    // biome-ignore lint/suspicious/noExplicitAny: <explanation>
    }) as any);
  }

  async run() {
    if (this.availableToolsList.length === 0 && !options.toolsConfig) {
        console.warn("[MCP Warning] No tools loaded and no tools config provided. Server will start with no active tools.");
    }
    // Ensure tools are loaded and filtered before connecting server
    this.loadAndFilterTools(); 
    // Server capabilities are set in constructor using this.enabledTools, which is now up-to-date.
    
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('PostgreSQL MCP server running on stdio');
  }
}

// For the final refactored version, tools will be imported and passed to the constructor.
// e.g.:
// import { analyzeDatabaseTool } from './tools/analyze';
// import { getSetupInstructionsTool } from './tools/setup';
// const allTools = [analyzeDatabaseTool, getSetupInstructionsTool /*, ...all other tools */];
// const serverInstance = new PostgreSQLServer(allTools);

// For now, initialize with an empty list. Tools will be refactored one by one.
const allTools: PostgresTool[] = [
    analyzeDatabaseTool,
    // Commented out for testing consolidated functions tool
    /*
    getFunctionsTool,
    createFunctionTool,
    dropFunctionTool,
    */
    // New consolidated functions tool
    manageFunctionsTool,
          manageRLSTool,
      debugDatabaseTool,     // Add debug tool
      manageSchemaTools,      // Add consolidated schema management tool (includes get_info, create_table, alter_table, get_enums, create_enum)
      exportTableDataTool,     // Add exportTableData tool
    importTableDataTool,     // Add importTableData tool
    copyBetweenDatabasesTool, // Add copyBetweenDatabases tool
    monitorDatabaseTool,      // Add monitorDatabase tool
    getSetupInstructionsTool, // Add getSetupInstructions tool
    // Trigger Management Tools (consolidated)
    manageTriggersTools,      // Add consolidated trigger management tool (includes get, create, drop, set_state)
    
    // Index Management Tools
    manageIndexesTool,
    
    // Query Performance Tools (consolidated)
    manageQueryTool,
    
    // User Management Tools
    manageUsersTool,
    
    // Constraint Management Tools
    manageConstraintsTool,

    // Data Query and Mutation Tools
    executeQueryTool,
    executeMutationTool,
    executeSqlTool
];

const serverInstance = new PostgreSQLServer(allTools); 

serverInstance.run().catch(error => {
  console.error('Failed to run the server:', error);
  process.exit(1);
});
