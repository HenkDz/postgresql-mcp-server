import { DatabaseConnection } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

interface TriggerResult {
  success: boolean;
  message: string;
  details: unknown;
}

interface TriggerInfo {
  name: string;
  tableName: string;
  tableSchema: string;
  event: string;
  timing: string;
  definition: string;
  function: string;
  enabled: boolean;
}

/**
 * Get information about database triggers
 */
export async function getTriggers(  connectionString: string,  tableName?: string,  schema = 'public'): Promise<TriggerResult> {
  const db = DatabaseConnection.getInstance();
  
  try {
    await db.connect(connectionString);
    
    let query = `
      SELECT 
        t.tgname AS name,
        c.relname AS "tableName",
        n.nspname AS "tableSchema",
        CASE
          WHEN (t.tgtype & (1<<0)) != 0 THEN 'ROW'
          ELSE 'STATEMENT'
        END AS level,
        CASE
          WHEN (t.tgtype & (1<<1)) != 0 THEN 'BEFORE'
          WHEN (t.tgtype & (1<<6)) != 0 THEN 'INSTEAD OF'
          ELSE 'AFTER'
        END AS timing,
        CASE
          WHEN (t.tgtype & (1<<2)) != 0 THEN 'INSERT'
          WHEN (t.tgtype & (1<<3)) != 0 THEN 'DELETE'
          WHEN (t.tgtype & (1<<4)) != 0 THEN 'UPDATE'
          WHEN (t.tgtype & (1<<5)) != 0 THEN 'TRUNCATE'
          ELSE 'UNKNOWN'
        END AS event,
        p.proname AS function,
        pg_get_triggerdef(t.oid) AS definition,
        -- PostgreSQL version-compatible enabled status
        -- Note: For older PostgreSQL versions without tgenabled, this will always return true
        true AS enabled
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_proc p ON t.tgfoid = p.oid
      WHERE NOT t.tgisinternal
    `;
    
    const params = [];
    
    if (schema) {
      query += ` AND n.nspname = $${params.length + 1}`;
      params.push(schema);
    }
    
    if (tableName) {
      query += ` AND c.relname = $${params.length + 1}`;
      params.push(tableName);
    }
    
    query += ' ORDER BY c.relname, t.tgname';
    
    const triggers = await db.query<TriggerInfo>(query, params);
    
    return {
      success: true,
      message: tableName 
        ? `Triggers for table ${schema}.${tableName}` 
        : `Found ${triggers.length} triggers in schema ${schema}`,
      details: triggers
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get trigger information: ${error instanceof Error ? error.message : String(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Create a trigger
 */
export async function createTrigger(
  connectionString: string,
  triggerName: string,
  tableName: string,
  functionName: string,
  options: {
    schema?: string;
    timing?: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
    events?: ('INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE')[];
    when?: string;
    forEach?: 'ROW' | 'STATEMENT';
    replace?: boolean;
  } = {}
): Promise<TriggerResult> {
  const db = DatabaseConnection.getInstance();
  
  try {
    await db.connect(connectionString);
    
    const schema = options.schema || 'public';
    const timing = options.timing || 'AFTER';
    const events = options.events || ['INSERT'];
    const forEach = options.forEach || 'ROW';
    const createOrReplace = options.replace ? 'CREATE OR REPLACE' : 'CREATE';
    
    // Build trigger creation SQL
    let sql = `
      ${createOrReplace} TRIGGER ${triggerName}
      ${timing} ${events.join(' OR ')}
      ON ${schema}.${tableName}
    `;
    
    // Add FOR EACH clause
    if (forEach) {
      sql += ` FOR EACH ${forEach}`;
    }
    
    // Add WHEN clause if provided
    if (options.when) {
      sql += ` WHEN (${options.when})`;
    }
    
    // Add EXECUTE PROCEDURE clause
    sql += ` EXECUTE FUNCTION ${functionName}()`;
    
    await db.query(sql);
    
    return {
      success: true,
      message: `Trigger ${triggerName} created successfully on ${schema}.${tableName}`,
      details: {
        name: triggerName,
        table: tableName,
        schema,
        timing,
        events,
        function: functionName
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to create trigger: ${error instanceof Error ? error.message : String(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Drop a trigger
 */
export async function dropTrigger(
  connectionString: string,
  triggerName: string,
  tableName: string,
  options: {
    schema?: string;
    ifExists?: boolean;
    cascade?: boolean;
  } = {}
): Promise<TriggerResult> {
  const db = DatabaseConnection.getInstance();
  
  try {
    await db.connect(connectionString);
    
    const schema = options.schema || 'public';
    const ifExists = options.ifExists ? 'IF EXISTS' : '';
    const cascade = options.cascade ? 'CASCADE' : '';
    
    // Build trigger drop SQL
    let sql = `DROP TRIGGER ${ifExists} ${triggerName} ON ${schema}.${tableName}`;
    
    // Add cascade if specified
    if (cascade) {
      sql += ` ${cascade}`;
    }
    
    await db.query(sql);
    
    return {
      success: true,
      message: `Trigger ${triggerName} dropped successfully from ${schema}.${tableName}`,
      details: {
        name: triggerName,
        table: tableName,
        schema
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to drop trigger: ${error instanceof Error ? error.message : String(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Enable or disable a trigger
 */
export async function setTriggerState(
  connectionString: string,
  triggerName: string,
  tableName: string,
  enable: boolean,
  options: {
    schema?: string;
  } = {}
): Promise<TriggerResult> {
  const db = DatabaseConnection.getInstance();
  
  try {
    await db.connect(connectionString);
    
    const schema = options.schema || 'public';
    const action = enable ? 'ENABLE' : 'DISABLE';
    
    // Build trigger alter SQL
    const sql = `ALTER TABLE ${schema}.${tableName} ${action} TRIGGER ${triggerName}`;
    
    await db.query(sql);
    
    return {
      success: true,
      message: `Trigger ${triggerName} ${enable ? 'enabled' : 'disabled'} on ${schema}.${tableName}`,
      details: {
        name: triggerName,
        table: tableName,
        schema,
        enabled: enable
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to ${enable ? 'enable' : 'disable'} trigger: ${error instanceof Error ? error.message : String(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

// --- GetTriggers Tool ---
const GetTriggersInputSchema = z.object({
  connectionString: z.string().optional(),
  tableName: z.string().optional(),
  schema: z.string().optional().default('public'),
});
type GetTriggersInput = z.infer<typeof GetTriggersInputSchema>;

async function executeGetTriggers(  input: GetTriggersInput,  getConnectionString: GetConnectionStringFn): Promise<TriggerInfo[]> {  const resolvedConnectionString = getConnectionString(input.connectionString);  const db = DatabaseConnection.getInstance();  const { tableName, schema } = input;    try {    await db.connect(resolvedConnectionString);        let query = `
      SELECT 
        t.tgname AS name,
        c.relname AS "tableName",
        n.nspname AS "tableSchema",
        CASE
          WHEN (t.tgtype & (1<<0)) != 0 THEN 'ROW'
          ELSE 'STATEMENT'
        END AS level,
        CASE
          WHEN (t.tgtype & (1<<1)) != 0 THEN 'BEFORE'
          WHEN (t.tgtype & (1<<6)) != 0 THEN 'INSTEAD OF'
          ELSE 'AFTER'
        END AS timing,
        CASE
          WHEN (t.tgtype & (1<<2)) != 0 THEN 'INSERT'
          WHEN (t.tgtype & (1<<3)) != 0 THEN 'DELETE'
          WHEN (t.tgtype & (1<<4)) != 0 THEN 'UPDATE'
          WHEN (t.tgtype & (1<<5)) != 0 THEN 'TRUNCATE'
          ELSE 'UNKNOWN'
        END AS event,
        p.proname AS function,
        pg_get_triggerdef(t.oid) AS definition,
        -- PostgreSQL version-compatible enabled status
        -- Note: For older PostgreSQL versions without tgenabled, this will always return true
        true AS enabled
      FROM pg_trigger t
      JOIN pg_class c ON t.tgrelid = c.oid
      JOIN pg_namespace n ON c.relnamespace = n.oid
      JOIN pg_proc p ON t.tgfoid = p.oid
      WHERE NOT t.tgisinternal
    `;
    
    const params = [];
    
    if (schema) {
      query += ` AND n.nspname = $${params.length + 1}`;
      params.push(schema);
    }
    
    if (tableName) {
      query += ` AND c.relname = $${params.length + 1}`;
      params.push(tableName);
    }
    
    query += ' ORDER BY c.relname, t.tgname';
    
    const triggers = await db.query<TriggerInfo>(query, params);
    return triggers;
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to get trigger information: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const getTriggersTool: PostgresTool = {
  name: 'pg_get_triggers',
  description: 'Get information about PostgreSQL triggers. Use when the user needs to retrieve a specific resource by identifier. Unlike pg_get_constraints, pg_get_enums, this tool specifically handles pg get triggers.',
  inputSchema: GetTriggersInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = GetTriggersInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const triggers = await executeGetTriggers(validationResult.data, getConnectionString);
      const { tableName, schema } = validationResult.data;
      const message = tableName 
        ? `Triggers for table ${schema}.${tableName}` 
        : `Found ${triggers.length} triggers in schema ${schema}`;
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(triggers, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error getting triggers: ${errorMessage}` }], isError: true };
    }
  }
};

// --- CreateTrigger Tool ---
const CreateTriggerInputSchema = z.object({
  connectionString: z.string().optional(),
  triggerName: z.string(),
  tableName: z.string(),
  functionName: z.string(),
  schema: z.string().optional().default('public'),
  timing: z.enum(['BEFORE', 'AFTER', 'INSTEAD OF']).optional().default('AFTER'),
  events: z.array(z.enum(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])).min(1).optional().default(['INSERT']),
  when: z.string().optional(),
  forEach: z.enum(['ROW', 'STATEMENT']).optional().default('ROW'),
  replace: z.boolean().optional().default(false),
});
type CreateTriggerInput = z.infer<typeof CreateTriggerInputSchema>;

async function executeCreateTrigger(
  input: CreateTriggerInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ name: string; table: string; schema: string; timing: string; events: string[]; function: string }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { triggerName, tableName, functionName, schema, timing, events, when, forEach, replace } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    const createOrReplace = replace ? 'CREATE OR REPLACE' : 'CREATE';
    const qualifiedTableName = `"${schema}"."${tableName}"`;
    const qualifiedFunctionName = `"${functionName}"`; // Assuming functionName might also need quoting or schema qualification

    let sql = `
      ${createOrReplace} TRIGGER "${triggerName}"
      ${timing} ${events.join(' OR ')}
      ON ${qualifiedTableName}
    `;
    
    if (forEach) {
      sql += ` FOR EACH ${forEach}`;
    }
    
    if (when) {
      sql += ` WHEN (${when})`;
    }
    
    sql += ` EXECUTE FUNCTION ${qualifiedFunctionName}()`; // Ensure function has () if it's a procedure/function call
    
    await db.query(sql);
    
    return {
      name: triggerName,
      table: tableName,
      schema,
      timing,
      events,
      function: functionName
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to create trigger: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const createTriggerTool: PostgresTool = {
  name: 'pg_create_trigger',
  description: 'Create a PostgreSQL trigger. Use when the user wants to create a new resource that does not yet exist. Unlike pg_create_foreign_key, pg_create_constraint, this tool specifically handles pg create trigger.',
  inputSchema: CreateTriggerInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = CreateTriggerInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeCreateTrigger(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Trigger ${result.name} created successfully on ${result.schema}.${result.table}` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error creating trigger: ${errorMessage}` }], isError: true };
    }
  }
};

// --- DropTrigger Tool ---
const DropTriggerInputSchema = z.object({
  connectionString: z.string().optional(),
  triggerName: z.string(),
  tableName: z.string(),
  schema: z.string().optional().default('public'),
  ifExists: z.boolean().optional().default(false),
  cascade: z.boolean().optional().default(false),
});
type DropTriggerInput = z.infer<typeof DropTriggerInputSchema>;

async function executeDropTrigger(
  input: DropTriggerInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ name: string; table: string; schema: string }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { triggerName, tableName, schema, ifExists, cascade } = input;

  try {
    await db.connect(resolvedConnectionString);
    
    const ifExistsClause = ifExists ? 'IF EXISTS' : '';
    const cascadeClause = cascade ? 'CASCADE' : '';
    const qualifiedTableName = `"${schema}"."${tableName}"`;
    
    let sql = `DROP TRIGGER ${ifExistsClause} "${triggerName}" ON ${qualifiedTableName}`;
    if (cascadeClause) {
      sql += ` ${cascadeClause}`;
    }
    
    await db.query(sql);
    
    return { name: triggerName, table: tableName, schema };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to drop trigger: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const dropTriggerTool: PostgresTool = {
  name: 'pg_drop_trigger',
  description: 'Drop a PostgreSQL trigger. Use when the user wants to pg drop trigger. Unlike pg_drop_foreign_key, pg_drop_constraint, this tool specifically handles pg drop trigger.',
  inputSchema: DropTriggerInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = DropTriggerInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeDropTrigger(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Trigger ${result.name} dropped successfully from ${result.schema}.${result.table}` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error dropping trigger: ${errorMessage}` }], isError: true };
    }
  }
};

// --- SetTriggerState Tool ---
const SetTriggerStateInputSchema = z.object({
  connectionString: z.string().optional(),
  triggerName: z.string(),
  tableName: z.string(),
  enable: z.boolean(),
  schema: z.string().optional().default('public'),
});
type SetTriggerStateInput = z.infer<typeof SetTriggerStateInputSchema>;

async function executeSetTriggerState(
  input: SetTriggerStateInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ name: string; table: string; schema: string; enabled: boolean }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { triggerName, tableName, enable, schema } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    const action = enable ? 'ENABLE' : 'DISABLE';
    const qualifiedTableName = `"${schema}"."${tableName}"`;
        
    const sql = `ALTER TABLE ${qualifiedTableName} ${action} TRIGGER "${triggerName}"`;
    
    await db.query(sql);
    
    return { name: triggerName, table: tableName, schema, enabled: enable };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to set trigger state: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const setTriggerStateTool: PostgresTool = {
  name: 'pg_set_trigger_state',
  description: 'Enable or disable a PostgreSQL trigger. Use when the user wants to pg set trigger state. Unlike pg_create_trigger, pg_drop_trigger, this tool specifically handles pg set trigger state.',
  inputSchema: SetTriggerStateInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = SetTriggerStateInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeSetTriggerState(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Trigger ${result.name} ${result.enabled ? 'enabled' : 'disabled'} on ${result.schema}.${result.table}` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error setting trigger state: ${errorMessage}` }], isError: true };
    }
  }
};

// Complete Consolidated Trigger Management Tool (covers all 4 operations)
export const manageTriggersTools: PostgresTool = {
  name: 'pg_manage_triggers',
  description: 'Manage PostgreSQL triggers - get, create, drop, and enable/disable triggers. Examples: operation="get" to list triggers, operation="create" with triggerName, tableName, functionName, operation="drop" with triggerName and tableName, operation="set_state" with triggerName, tableName, enable. Use when the user wants to pg manage triggers. Unlike pg_manage_comments, pg_manage_constraints, this tool specifically handles pg manage triggers.',
  inputSchema: z.object({
    connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
    operation: z.enum(['get', 'create', 'drop', 'set_state']).describe('Operation: get (list triggers), create (new trigger), drop (remove trigger), set_state (enable/disable trigger)'),
    
    // Common parameters
    schema: z.string().optional().describe('Schema name (defaults to public)'),
    tableName: z.string().optional().describe('Table name (optional filter for get, required for create/drop/set_state)'),
    
    // Trigger identification (for create/drop/set_state)
    triggerName: z.string().optional().describe('Trigger name (required for create/drop/set_state)'),
    
    // Create trigger parameters
    functionName: z.string().optional().describe('Function name (required for create operation)'),
    timing: z.enum(['BEFORE', 'AFTER', 'INSTEAD OF']).optional().describe('Trigger timing (for create operation, defaults to AFTER)'),
    events: z.array(z.enum(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'])).optional().describe('Trigger events (for create operation, defaults to ["INSERT"])'),
    forEach: z.enum(['ROW', 'STATEMENT']).optional().describe('FOR EACH ROW or STATEMENT (for create operation, defaults to ROW)'),
    when: z.string().optional().describe('WHEN clause condition (for create operation)'),
    replace: z.boolean().optional().describe('Whether to replace trigger if exists (for create operation)'),
    
    // Drop trigger parameters
    ifExists: z.boolean().optional().describe('Include IF EXISTS clause (for drop operation)'),
    cascade: z.boolean().optional().describe('Include CASCADE clause (for drop operation)'),
    
    // Set state parameters
    enable: z.boolean().optional().describe('Whether to enable the trigger (required for set_state operation)')
  }),
  // biome-ignore lint/suspicious/noExplicitAny: <explanation>
  execute: async (args: any, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const { 
      connectionString: connStringArg,
      operation,
      schema,
      tableName,
      triggerName,
      functionName,
      timing,
      events,
      forEach,
      when,
      replace,
      ifExists,
      cascade,
      enable
    } = args as {
      connectionString?: string;
      operation: 'get' | 'create' | 'drop' | 'set_state';
      schema?: string;
      tableName?: string;
      triggerName?: string;
      functionName?: string;
      timing?: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
      events?: ('INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE')[];
      forEach?: 'ROW' | 'STATEMENT';
      when?: string;
      replace?: boolean;
      ifExists?: boolean;
      cascade?: boolean;
      enable?: boolean;
    };

    try {
      switch (operation) {
        case 'get': {
          const result = await executeGetTriggers({
            connectionString: connStringArg,
            tableName,
            schema: schema || 'public'
          }, getConnectionStringVal);
          const message = tableName 
            ? `Triggers for table ${schema || 'public'}.${tableName}` 
            : `Found ${result.length} triggers in schema ${schema || 'public'}`;
          return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'create': {
          if (!triggerName || !tableName || !functionName) {
            return { 
              content: [{ type: 'text', text: 'Error: triggerName, tableName, and functionName are required for create operation' }], 
              isError: true 
            };
          }
          const result = await executeCreateTrigger({
            connectionString: connStringArg,
            triggerName,
            tableName,
            functionName,
            schema: schema || 'public',
            timing: timing || 'AFTER',
            events: events || ['INSERT'],
            forEach: forEach || 'ROW',
            when,
            replace: replace || false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Trigger ${result.name} created successfully on ${result.schema}.${result.table}` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'drop': {
          if (!triggerName || !tableName) {
            return { 
              content: [{ type: 'text', text: 'Error: triggerName and tableName are required for drop operation' }], 
              isError: true 
            };
          }
          const result = await executeDropTrigger({
            connectionString: connStringArg,
            triggerName,
            tableName,
            schema: schema || 'public',
            ifExists: ifExists || false,
            cascade: cascade || false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Trigger ${result.name} dropped successfully from ${result.schema}.${result.table}` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'set_state': {
          if (!triggerName || !tableName || enable === undefined) {
            return { 
              content: [{ type: 'text', text: 'Error: triggerName, tableName, and enable are required for set_state operation' }], 
              isError: true 
            };
          }
          const result = await executeSetTriggerState({
            connectionString: connStringArg,
            triggerName,
            tableName,
            enable,
            schema: schema || 'public'
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Trigger ${result.name} ${result.enabled ? 'enabled' : 'disabled'} on ${result.schema}.${result.table}` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return { 
            content: [{ type: 'text', text: `Error: Unknown operation "${operation}". Supported operations: get, create, drop, set_state` }], 
            isError: true 
          };
      }

    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error executing ${operation} operation: ${errorMessage}` }], isError: true };
    }
  }
};

 