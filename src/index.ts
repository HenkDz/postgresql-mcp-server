#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';

import { analyzeDatabase } from './tools/analyze.js';
import { getSetupInstructions } from './tools/setup.js';
import { debugDatabase } from './tools/debug.js';
import { getSchemaInfo, createTable, alterTable } from './tools/schema.js';
import { exportTableData, importTableData, copyBetweenDatabases } from './tools/migration.js';
import { monitorDatabase } from './tools/monitor.js';
import { 
  getFunctions, 
  createFunction, 
  dropFunction, 
  enableRLS, 
  disableRLS, 
  createRLSPolicy, 
  dropRLSPolicy, 
  getRLSPolicies 
} from './tools/functions.js';
import {
  setDatabaseComment,
  removeDatabaseComment,
  getDatabaseComment
} from './tools/comment.js';
import {
  getTriggers,
  createTrigger,
  dropTrigger,
  setTriggerState
} from './tools/triggers.js';
import { DatabaseConnection } from './utils/connection.js';

// Define all tool definitions
const TOOL_DEFINITIONS = [
  // Original tools
  {
    name: 'analyze_database',
    description: 'Analyze PostgreSQL database configuration and performance',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        analysisType: {
          type: 'string',
          enum: ['configuration', 'performance', 'security'],
          description: 'Type of analysis to perform'
        }
      },
      required: ['connectionString']
    }
  },
  {
    name: 'get_setup_instructions',
    description: 'Get step-by-step PostgreSQL setup instructions',
    inputSchema: {
      type: 'object',
      properties: {
        version: {
          type: 'string',
          description: 'PostgreSQL version to install'
        },
        platform: {
          type: 'string',
          enum: ['linux', 'macos', 'windows'],
          description: 'Operating system platform'
        },
        useCase: {
          type: 'string',
          enum: ['development', 'production'],
          description: 'Intended use case'
        }
      },
      required: ['platform']
    }
  },
  {
    name: 'debug_database',
    description: 'Debug common PostgreSQL issues',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        issue: {
          type: 'string',
          enum: [
            'connection',
            'performance',
            'locks',
            'replication'
          ],
          description: 'Type of issue to debug'
        },
        logLevel: {
          type: 'string',
          enum: ['info', 'debug', 'trace'],
          default: 'info',
          description: 'Logging detail level'
        }
      },
      required: ['connectionString', 'issue']
    }
  },
  
  // New schema management tools
  {
    name: 'get_schema_info',
    description: 'Get schema information for a database or specific table',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Optional table name to get detailed schema for'
        }
      },
      required: ['connectionString']
    }
  },
  {
    name: 'create_table',
    description: 'Create a new table in the database',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table to create'
        },
        columns: {
          type: 'array',
          description: 'Column definitions',
          items: {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Column name'
              },
              type: {
                type: 'string',
                description: 'PostgreSQL data type'
              },
              nullable: {
                type: 'boolean',
                description: 'Whether the column can be NULL'
              },
              default: {
                type: 'string',
                description: 'Default value expression'
              }
            },
            required: ['name', 'type']
          }
        }
      },
      required: ['connectionString', 'tableName', 'columns']
    }
  },
  {
    name: 'alter_table',
    description: 'Alter an existing table (add/modify/drop columns)',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table to alter'
        },
        operations: {
          type: 'array',
          description: 'Operations to perform',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: ['add', 'alter', 'drop'],
                description: 'Type of operation'
              },
              columnName: {
                type: 'string',
                description: 'Column name'
              },
              dataType: {
                type: 'string',
                description: 'PostgreSQL data type (for add/alter)'
              },
              nullable: {
                type: 'boolean',
                description: 'Whether the column can be NULL (for add/alter)'
              },
              default: {
                type: 'string',
                description: 'Default value expression (for add/alter)'
              }
            },
            required: ['type', 'columnName']
          }
        }
      },
      required: ['connectionString', 'tableName', 'operations']
    }
  },
  
  // New data migration tools
  {
    name: 'export_table_data',
    description: 'Export table data to JSON or CSV format',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table to export'
        },
        outputPath: {
          type: 'string',
          description: 'Path to save the exported data'
        },
        where: {
          type: 'string',
          description: 'Optional WHERE clause to filter data'
        },
        limit: {
          type: 'number',
          description: 'Optional limit on number of rows to export'
        },
        format: {
          type: 'string',
          enum: ['json', 'csv'],
          default: 'json',
          description: 'Output format'
        }
      },
      required: ['connectionString', 'tableName', 'outputPath']
    }
  },
  {
    name: 'import_table_data',
    description: 'Import data from JSON or CSV file into a table',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table to import into'
        },
        inputPath: {
          type: 'string',
          description: 'Path to the file to import'
        },
        truncateFirst: {
          type: 'boolean',
          default: false,
          description: 'Whether to truncate the table before importing'
        },
        format: {
          type: 'string',
          enum: ['json', 'csv'],
          default: 'json',
          description: 'Input format'
        },
        delimiter: {
          type: 'string',
          default: ',',
          description: 'Delimiter for CSV files'
        }
      },
      required: ['connectionString', 'tableName', 'inputPath']
    }
  },
  {
    name: 'copy_between_databases',
    description: 'Copy data between two databases',
    inputSchema: {
      type: 'object',
      properties: {
        sourceConnectionString: {
          type: 'string',
          description: 'Source PostgreSQL connection string'
        },
        targetConnectionString: {
          type: 'string',
          description: 'Target PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table to copy'
        },
        where: {
          type: 'string',
          description: 'Optional WHERE clause to filter data'
        },
        truncateTarget: {
          type: 'boolean',
          default: false,
          description: 'Whether to truncate the target table before copying'
        }
      },
      required: ['sourceConnectionString', 'targetConnectionString', 'tableName']
    }
  },
  
  // New monitoring tool
  {
    name: 'monitor_database',
    description: 'Get real-time monitoring information for a PostgreSQL database',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        includeTables: {
          type: 'boolean',
          default: true,
          description: 'Whether to include table metrics'
        },
        includeQueries: {
          type: 'boolean',
          default: true,
          description: 'Whether to include active query information'
        },
        includeLocks: {
          type: 'boolean',
          default: true,
          description: 'Whether to include lock information'
        },
        includeReplication: {
          type: 'boolean',
          default: false,
          description: 'Whether to include replication information'
        },
        alertThresholds: {
          type: 'object',
          description: 'Alert thresholds',
          properties: {
            connectionPercentage: {
              type: 'number',
              description: 'Connection usage percentage threshold'
            },
            longRunningQuerySeconds: {
              type: 'number',
              description: 'Long-running query threshold in seconds'
            },
            cacheHitRatio: {
              type: 'number',
              description: 'Cache hit ratio threshold'
            },
            deadTuplesPercentage: {
              type: 'number',
              description: 'Dead tuples percentage threshold'
            },
            vacuumAge: {
              type: 'number',
              description: 'Vacuum age threshold in days'
            }
          }
        }
      },
      required: ['connectionString']
    }
  },

  // Function management tools
  {
    name: 'get_functions',
    description: 'Get information about PostgreSQL functions',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        functionName: {
          type: 'string',
          description: 'Optional function name to filter by'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        }
      },
      required: ['connectionString']
    }
  },
  {
    name: 'create_function',
    description: 'Create or replace a PostgreSQL function',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        functionName: {
          type: 'string',
          description: 'Name of the function to create'
        },
        parameters: {
          type: 'string',
          description: 'Function parameters (e.g., "id integer, name text")'
        },
        returnType: {
          type: 'string',
          description: 'Return type of the function'
        },
        functionBody: {
          type: 'string',
          description: 'Function body code'
        },
        language: {
          type: 'string',
          enum: ['sql', 'plpgsql', 'plpython3u'],
          description: 'Function language'
        },
        volatility: {
          type: 'string',
          enum: ['VOLATILE', 'STABLE', 'IMMUTABLE'],
          description: 'Function volatility'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        },
        security: {
          type: 'string',
          enum: ['INVOKER', 'DEFINER'],
          description: 'Function security context'
        },
        replace: {
          type: 'boolean',
          description: 'Whether to replace the function if it exists'
        }
      },
      required: ['connectionString', 'functionName', 'parameters', 'returnType', 'functionBody']
    }
  },
  {
    name: 'drop_function',
    description: 'Drop a PostgreSQL function',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        functionName: {
          type: 'string',
          description: 'Name of the function to drop'
        },
        parameters: {
          type: 'string',
          description: 'Function parameters signature (required for overloaded functions)'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        },
        ifExists: {
          type: 'boolean',
          description: 'Whether to include IF EXISTS clause'
        },
        cascade: {
          type: 'boolean',
          description: 'Whether to include CASCADE clause'
        }
      },
      required: ['connectionString', 'functionName']
    }
  },
  
  // Row-Level Security (RLS) tools
  {
    name: 'enable_rls',
    description: 'Enable Row-Level Security on a table',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table to enable RLS on'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        }
      },
      required: ['connectionString', 'tableName']
    }
  },
  {
    name: 'disable_rls',
    description: 'Disable Row-Level Security on a table',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table to disable RLS on'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        }
      },
      required: ['connectionString', 'tableName']
    }
  },
  {
    name: 'create_rls_policy',
    description: 'Create a Row-Level Security policy',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table to create policy on'
        },
        policyName: {
          type: 'string',
          description: 'Name of the policy to create'
        },
        using: {
          type: 'string',
          description: 'USING expression for the policy (e.g., "user_id = current_user_id()")'
        },
        check: {
          type: 'string',
          description: 'WITH CHECK expression for the policy (if different from USING)'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        },
        command: {
          type: 'string',
          enum: ['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE'],
          description: 'Command the policy applies to'
        },
        role: {
          type: 'string',
          description: 'Role the policy applies to'
        },
        replace: {
          type: 'boolean',
          description: 'Whether to replace the policy if it exists'
        }
      },
      required: ['connectionString', 'tableName', 'policyName', 'using']
    }
  },
  {
    name: 'drop_rls_policy',
    description: 'Drop a Row-Level Security policy',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table the policy is on'
        },
        policyName: {
          type: 'string',
          description: 'Name of the policy to drop'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        },
        ifExists: {
          type: 'boolean',
          description: 'Whether to include IF EXISTS clause'
        }
      },
      required: ['connectionString', 'tableName', 'policyName']
    }
  },
  {
    name: 'get_rls_policies',
    description: 'Get Row-Level Security policies',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Optional table name to filter by'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        }
      },
      required: ['connectionString']
    }
  },

  // Trigger management tools
  {
    name: 'get_triggers',
    description: 'Get information about PostgreSQL triggers',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        tableName: {
          type: 'string',
          description: 'Optional table name to filter by'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        }
      },
      required: ['connectionString']
    }
  },
  {
    name: 'create_trigger',
    description: 'Create a PostgreSQL trigger',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        triggerName: {
          type: 'string',
          description: 'Name of the trigger to create'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table to create trigger on'
        },
        functionName: {
          type: 'string',
          description: 'Name of the function to execute'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        },
        timing: {
          type: 'string',
          enum: ['BEFORE', 'AFTER', 'INSTEAD OF'],
          description: 'When to fire the trigger'
        },
        events: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']
          },
          description: 'Events that fire the trigger'
        },
        when: {
          type: 'string',
          description: 'Optional WHEN condition'
        },
        forEach: {
          type: 'string',
          enum: ['ROW', 'STATEMENT'],
          description: 'Whether to fire once per row or statement'
        },
        replace: {
          type: 'boolean',
          description: 'Whether to replace the trigger if it exists'
        }
      },
      required: ['connectionString', 'triggerName', 'tableName', 'functionName']
    }
  },
  {
    name: 'drop_trigger',
    description: 'Drop a PostgreSQL trigger',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        triggerName: {
          type: 'string',
          description: 'Name of the trigger to drop'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table the trigger is on'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        },
        ifExists: {
          type: 'boolean',
          description: 'Whether to include IF EXISTS clause'
        },
        cascade: {
          type: 'boolean',
          description: 'Whether to include CASCADE clause'
        }
      },
      required: ['connectionString', 'triggerName', 'tableName']
    }
  },
  {
    name: 'set_trigger_state',
    description: 'Enable or disable a PostgreSQL trigger',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        triggerName: {
          type: 'string',
          description: 'Name of the trigger to enable/disable'
        },
        tableName: {
          type: 'string',
          description: 'Name of the table the trigger is on'
        },
        enable: {
          type: 'boolean',
          description: 'Whether to enable (true) or disable (false) the trigger'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        }
      },
      required: ['connectionString', 'triggerName', 'tableName', 'enable']
    }
  },
  
  // Comment management tools
  {
    name: 'set_database_comment',
    description: 'Set a comment on a database object',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        objectType: {
          type: 'string',
          enum: ['table', 'column', 'function', 'policy', 'trigger', 'constraint', 'index', 'sequence'],
          description: 'Type of database object (table, column, function, policy, etc.)'
        },
        objectName: {
          type: 'string',
          description: 'Name of the object to comment on'
        },
        comment: {
          type: 'string',
          description: 'The comment text'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        },
        parentObject: {
          type: 'string',
          description: 'For columns, constraints, policies, triggers'
        },
        parameters: {
          type: 'string',
          description: 'For functions'
        }
      },
      required: ['connectionString', 'objectType', 'objectName', 'comment']
    }
  },
  {
    name: 'remove_database_comment',
    description: 'Remove a comment from a database object',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        objectType: {
          type: 'string',
          enum: ['table', 'column', 'function', 'policy', 'trigger', 'constraint', 'index', 'sequence'],
          description: 'Type of database object (table, column, function, policy, etc.)'
        },
        objectName: {
          type: 'string',
          description: 'Name of the object to remove comment from'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        },
        parentObject: {
          type: 'string',
          description: 'For columns, constraints, policies, triggers'
        },
        parameters: {
          type: 'string',
          description: 'For functions'
        }
      },
      required: ['connectionString', 'objectType', 'objectName']
    }
  },
  {
    name: 'get_database_comment',
    description: 'Get a comment from a database object',
    inputSchema: {
      type: 'object',
      properties: {
        connectionString: {
          type: 'string',
          description: 'PostgreSQL connection string'
        },
        objectType: {
          type: 'string',
          enum: ['table', 'column', 'function', 'policy', 'trigger', 'constraint', 'index', 'sequence'],
          description: 'Type of database object (table, column, function, policy, etc.)'
        },
        objectName: {
          type: 'string',
          description: 'Name of the object to get comment from'
        },
        schema: {
          type: 'string',
          description: 'Schema name (defaults to public)'
        },
        parentObject: {
          type: 'string',
          description: 'For columns, constraints, policies, triggers'
        },
        parameters: {
          type: 'string',
          description: 'For functions'
        }
      },
      required: ['connectionString', 'objectType', 'objectName']
    }
  }
];

class PostgreSQLServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'postgresql-mcp-server',
        version: '0.2.0',
      },
      {
        capabilities: {
          tools: TOOL_DEFINITIONS.reduce((acc, tool) => {
            acc[tool.name] = tool;
            return acc;
          }, {} as Record<string, any>),
        },
      }
    );

    this.setupToolHandlers();
    
    // Error handling
    this.server.onerror = (error) => console.error('[MCP Error]', error);
    
    // Cleanup on exit
    process.on('SIGINT', async () => {
      await this.cleanup();
      process.exit(0);
    });
    
    process.on('SIGTERM', async () => {
      await this.cleanup();
      process.exit(0);
    });
  }

  private async cleanup(): Promise<void> {
    console.error('Shutting down PostgreSQL MCP server...');
    await DatabaseConnection.cleanupPools();
    await this.server.close();
  }

  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          // Original tools
          case 'analyze_database': {
            const { connectionString, analysisType } = request.params.arguments as {
              connectionString: string;
              analysisType?: 'configuration' | 'performance' | 'security';
            };
            const result = await analyzeDatabase(connectionString, analysisType);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }

          case 'get_setup_instructions': {
            const { platform, version, useCase } = request.params.arguments as {
              platform: 'linux' | 'macos' | 'windows';
              version?: string;
              useCase?: 'development' | 'production';
            };
            const instructions = getSetupInstructions(platform, version, useCase);
            return {
              content: [
                {
                  type: 'text',
                  text: [
                    '# Installation Steps',
                    ...instructions.steps,
                    '',
                    '# Configuration',
                    ...instructions.configuration,
                    '',
                    '# Post-Installation Steps',
                    ...instructions.postInstall
                  ].join('\n')
                }
              ]
            };
          }

          case 'debug_database': {
            const { connectionString, issue, logLevel } = request.params.arguments as {
              connectionString: string;
              issue: 'connection' | 'performance' | 'locks' | 'replication';
              logLevel?: 'info' | 'debug' | 'trace';
            };
            const result = await debugDatabase(connectionString, issue, logLevel);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          // Schema management tools
          case 'get_schema_info': {
            const { connectionString, tableName } = request.params.arguments as {
              connectionString: string;
              tableName?: string;
            };
            const result = await getSchemaInfo(connectionString, tableName);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'create_table': {
            const { connectionString, tableName, columns } = request.params.arguments as {
              connectionString: string;
              tableName: string;
              columns: { name: string; type: string; nullable?: boolean; default?: string }[];
            };
            const result = await createTable(connectionString, tableName, columns);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'alter_table': {
            const { connectionString, tableName, operations } = request.params.arguments as {
              connectionString: string;
              tableName: string;
              operations: {
                type: 'add' | 'alter' | 'drop';
                columnName: string;
                dataType: string;
                nullable?: boolean;
                default?: string;
              }[];
            };
            const result = await alterTable(connectionString, tableName, operations);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          // Data migration tools
          case 'export_table_data': {
            const { connectionString, tableName, outputPath, where, limit, format } = request.params.arguments as {
              connectionString: string;
              tableName: string;
              outputPath: string;
              where?: string;
              limit?: number;
              format?: 'json' | 'csv';
            };
            const result = await exportTableData(connectionString, tableName, outputPath, { where, limit, format });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'import_table_data': {
            const { connectionString, tableName, inputPath, truncateFirst, format, delimiter } = request.params.arguments as {
              connectionString: string;
              tableName: string;
              inputPath: string;
              truncateFirst?: boolean;
              format?: 'json' | 'csv';
              delimiter?: string;
            };
            const result = await importTableData(connectionString, tableName, inputPath, { truncateFirst, format, delimiter });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'copy_between_databases': {
            const { sourceConnectionString, targetConnectionString, tableName, where, truncateTarget } = request.params.arguments as {
              sourceConnectionString: string;
              targetConnectionString: string;
              tableName: string;
              where?: string;
              truncateTarget?: boolean;
            };
            const result = await copyBetweenDatabases(sourceConnectionString, targetConnectionString, tableName, { where, truncateTarget });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          // Monitoring tool
          case 'monitor_database': {
            const { connectionString, includeTables, includeQueries, includeLocks, includeReplication, alertThresholds } = request.params.arguments as {
              connectionString: string;
              includeTables?: boolean;
              includeQueries?: boolean;
              includeLocks?: boolean;
              includeReplication?: boolean;
              alertThresholds?: {
                connectionPercentage?: number;
                longRunningQuerySeconds?: number;
                cacheHitRatio?: number;
                deadTuplesPercentage?: number;
                vacuumAge?: number;
              };
            };
            const result = await monitorDatabase(connectionString, { 
              includeTables, 
              includeQueries, 
              includeLocks, 
              includeReplication, 
              alertThresholds 
            });
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }

          // Function management handlers
          case 'get_functions': {
            const { connectionString, functionName, schema } = request.params.arguments as {
              connectionString: string;
              functionName?: string;
              schema?: string;
            };
            const result = await getFunctions(connectionString, functionName, schema);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'create_function': {
            const { connectionString, functionName, parameters, returnType, functionBody, language, volatility, schema, security, replace } = request.params.arguments as {
              connectionString: string;
              functionName: string;
              parameters: string;
              returnType: string;
              functionBody: string;
              language?: 'sql' | 'plpgsql' | 'plpython3u';
              volatility?: 'VOLATILE' | 'STABLE' | 'IMMUTABLE';
              schema?: string;
              security?: 'INVOKER' | 'DEFINER';
              replace?: boolean;
            };
            const result = await createFunction(
              connectionString,
              functionName,
              parameters,
              returnType,
              functionBody,
              {
                language,
                volatility,
                schema,
                security,
                replace
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'drop_function': {
            const { connectionString, functionName, parameters, schema, ifExists, cascade } = request.params.arguments as {
              connectionString: string;
              functionName: string;
              parameters: string;
              schema?: string;
              ifExists: boolean;
              cascade: boolean;
            };
            const result = await dropFunction(
              connectionString,
              functionName,
              parameters,
              {
                schema,
                ifExists,
                cascade
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          // Row-Level Security handlers
          case 'enable_rls': {
            const { connectionString, tableName, schema } = request.params.arguments as {
              connectionString: string;
              tableName: string;
              schema?: string;
            };
            const result = await enableRLS(connectionString, tableName, schema);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'disable_rls': {
            const { connectionString, tableName, schema } = request.params.arguments as {
              connectionString: string;
              tableName: string;
              schema?: string;
            };
            const result = await disableRLS(connectionString, tableName, schema);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'create_rls_policy': {
            const { connectionString, tableName, policyName, using, check, schema, command, role, replace } = request.params.arguments as {
              connectionString: string;
              tableName: string;
              policyName: string;
              using: string;
              check?: string;
              schema?: string;
              command?: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
              role?: string;
              replace?: boolean;
            };
            const result = await createRLSPolicy(
              connectionString,
              tableName,
              policyName,
              using,
              check,
              {
                schema,
                command,
                role,
                replace
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'drop_rls_policy': {
            const { connectionString, tableName, policyName, schema, ifExists } = request.params.arguments as {
              connectionString: string;
              tableName: string;
              policyName: string;
              schema?: string;
              ifExists: boolean;
            };
            const result = await dropRLSPolicy(
              connectionString,
              tableName,
              policyName,
              {
                schema,
                ifExists
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'get_rls_policies': {
            const { connectionString, tableName, schema } = request.params.arguments as {
              connectionString: string;
              tableName?: string;
              schema?: string;
            };
            const result = await getRLSPolicies(connectionString, tableName, schema);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }

          // Trigger management handlers
          case 'get_triggers': {
            const { connectionString, tableName, schema } = request.params.arguments as {
              connectionString: string;
              tableName?: string;
              schema?: string;
            };
            const result = await getTriggers(connectionString, tableName, schema);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'create_trigger': {
            const { connectionString, triggerName, tableName, functionName, schema, timing, events, when, forEach, replace } = request.params.arguments as {
              connectionString: string;
              triggerName: string;
              tableName: string;
              functionName: string;
              schema?: string;
              timing?: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
              events?: ('INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE')[];
              when?: string;
              forEach?: 'ROW' | 'STATEMENT';
              replace?: boolean;
            };
            const result = await createTrigger(
              connectionString,
              triggerName,
              tableName,
              functionName,
              {
                schema,
                timing,
                events,
                when,
                forEach,
                replace
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'drop_trigger': {
            const { connectionString, triggerName, tableName, schema, ifExists, cascade } = request.params.arguments as {
              connectionString: string;
              triggerName: string;
              tableName: string;
              schema?: string;
              ifExists?: boolean;
              cascade?: boolean;
            };
            const result = await dropTrigger(
              connectionString,
              triggerName,
              tableName,
              {
                schema,
                ifExists,
                cascade
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'set_trigger_state': {
            const { connectionString, triggerName, tableName, enable, schema } = request.params.arguments as {
              connectionString: string;
              triggerName: string;
              tableName: string;
              enable: boolean;
              schema?: string;
            };
            const result = await setTriggerState(
              connectionString,
              triggerName,
              tableName,
              enable,
              {
                schema
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          // Comment management handlers
          case 'set_database_comment': {
            const { connectionString, objectType, objectName, comment, schema, parentObject, parameters } = request.params.arguments as {
              connectionString: string;
              objectType: 'table' | 'column' | 'function' | 'policy' | 'trigger' | 'constraint' | 'index' | 'sequence';
              objectName: string;
              comment: string;
              schema?: string;
              parentObject?: string;
              parameters?: string;
            };
            const result = await setDatabaseComment(
              connectionString,
              objectType,
              objectName,
              comment,
              {
                schema,
                parentObject,
                parameters
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'remove_database_comment': {
            const { connectionString, objectType, objectName, schema, parentObject, parameters } = request.params.arguments as {
              connectionString: string;
              objectType: 'table' | 'column' | 'function' | 'policy' | 'trigger' | 'constraint' | 'index' | 'sequence';
              objectName: string;
              schema?: string;
              parentObject?: string;
              parameters?: string;
            };
            const result = await removeDatabaseComment(
              connectionString,
              objectType,
              objectName,
              {
                schema,
                parentObject,
                parameters
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }
          
          case 'get_database_comment': {
            const { connectionString, objectType, objectName, schema, parentObject, parameters } = request.params.arguments as {
              connectionString: string;
              objectType: 'table' | 'column' | 'function' | 'policy' | 'trigger' | 'constraint' | 'index' | 'sequence';
              objectName: string;
              schema?: string;
              parentObject?: string;
              parameters?: string;
            };
            const result = await getDatabaseComment(
              connectionString,
              objectType,
              objectName,
              {
                schema,
                parentObject,
                parameters
              }
            );
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify(result, null, 2)
                }
              ]
            };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        console.error(`Error handling request for tool ${request.params.name}:`, error);
        return {
          content: [
            {
              type: 'text',
              text: `Error: ${error instanceof Error ? error.message : String(error)}`
            }
          ],
          isError: true
        };
      }
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('PostgreSQL MCP server running on stdio');
  }
}

const server = new PostgreSQLServer();
server.run().catch(console.error);
