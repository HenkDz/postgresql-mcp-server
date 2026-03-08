import { z } from 'zod';
import { DatabaseConnection } from '../utils/connection.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { PostgresTool, ToolOutput, GetConnectionStringFn } from '../types/tool.js';

// ===== EXECUTE QUERY TOOL (SELECT operations) =====

const ExecuteQueryInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['select', 'count', 'exists']).describe('Query operation: select (fetch rows), count (count rows), exists (check existence)'),
  query: z.string().describe('SQL SELECT query to execute'),
  parameters: z.array(z.unknown()).optional().default([]).describe('Parameter values for prepared statement placeholders ($1, $2, etc.)'),
  limit: z.number().optional().describe('Maximum number of rows to return (safety limit)'),
  timeout: z.number().optional().describe('Query timeout in milliseconds')
});

type ExecuteQueryInput = z.infer<typeof ExecuteQueryInputSchema>;

async function executeQuery(
  input: ExecuteQueryInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ operation: string; rowCount: number; rows?: unknown[]; result?: unknown }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { operation, query, parameters, limit, timeout } = input;

  try {
    await db.connect(resolvedConnectionString);
    
    // Validate query is a SELECT-like operation
    const trimmedQuery = query.trim().toLowerCase();
    if (!trimmedQuery.startsWith('select') && !trimmedQuery.startsWith('with')) {
      throw new McpError(ErrorCode.InvalidParams, 'Query must be a SELECT statement or CTE (WITH clause)');
    }

    let finalQuery = query;
    const queryParams = parameters || [];

    // Apply limit if specified and not already in query
    if (limit && !trimmedQuery.includes('limit')) {
      finalQuery += ` LIMIT ${limit}`;
    }

    const queryOptions = timeout ? { timeout } : {};

    switch (operation) {
      case 'select': {
        const rows = await db.query(finalQuery, queryParams, queryOptions);
        return {
          operation: 'select',
          rowCount: rows.length,
          rows: rows
        };
      }

      case 'count': {
        // Wrap the query in a COUNT to get total rows
        const countQuery = `SELECT COUNT(*) as total FROM (${query}) as subquery`;
        const result = await db.queryOne<{ total: number }>(countQuery, queryParams, queryOptions);
        return {
          operation: 'count',
          rowCount: 1,
          result: result?.total || 0
        };
      }

      case 'exists': {
        // Wrap the query in an EXISTS check
        const existsQuery = `SELECT EXISTS (${query}) as exists`;
        const result = await db.queryOne<{ exists: boolean }>(existsQuery, queryParams, queryOptions);
        return {
          operation: 'exists',
          rowCount: 1,
          result: result?.exists || false
        };
      }

      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown operation: ${operation}`);
    }
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to execute query: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const executeQueryTool: PostgresTool = {
  name: 'pg_execute_query',
  description: 'Execute SELECT queries and data retrieval operations - operation="select/count/exists" with query and optional parameters. Examples: operation="select", query="SELECT * FROM users WHERE created_at > $1", parameters=["2024-01-01"]. Use when the user wants to extract specific data using a structured query. Unlike pg_execute_mutation, pg_execute_sql, this tool specifically handles pg execute query.',
  inputSchema: ExecuteQueryInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const { 
      connectionString: connStringArg,
      operation,
      query,
      parameters,
      limit,
      timeout
    } = args as {
      connectionString?: string;
      operation: 'select' | 'count' | 'exists';
      query: string;
      parameters?: unknown[];
      limit?: number;
      timeout?: number;
    };

    const resolvedConnString = getConnectionStringVal(connStringArg);

    try {
      // Input validation
      if (!query?.trim()) {
        return { 
          content: [{ type: 'text', text: 'Error: query is required' }], 
          isError: true 
        };
      }

      const result = await executeQuery({
        connectionString: resolvedConnString,
        operation,
        query,
        parameters: parameters ?? [],
        limit,
        timeout
      }, getConnectionStringVal);

      let responseText = '';
      switch (operation) {
        case 'select':
          responseText = `Query executed successfully. Retrieved ${result.rowCount} rows.\n\nResults:\n${JSON.stringify(result.rows, null, 2)}`;
          break;
        case 'count':
          responseText = `Count query executed successfully. Total rows: ${result.result}`;
          break;
        case 'exists':
          responseText = `Exists query executed successfully. Result: ${result.result ? 'EXISTS' : 'NOT EXISTS'}`;
          break;
      }

      return { content: [{ type: 'text', text: responseText }] };

    } catch (error) {
      return { 
        content: [{ type: 'text', text: `Error executing ${operation} query: ${error instanceof Error ? error.message : String(error)}` }], 
        isError: true 
      };
    }
  }
};

// ===== EXECUTE MUTATION TOOL (INSERT/UPDATE/DELETE operations) =====

const ExecuteMutationInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['insert', 'update', 'delete', 'upsert']).describe('Mutation operation: insert (add rows), update (modify rows), delete (remove rows), upsert (insert or update)'),
  table: z.string().describe('Table name for the operation'),
  data: z.record(z.unknown()).optional().describe('Data object with column-value pairs (required for insert/update/upsert)'),
  where: z.string().optional().describe('WHERE clause for update/delete operations (without WHERE keyword)'),
  conflictColumns: z.array(z.string()).optional().describe('Columns for conflict resolution in upsert (ON CONFLICT)'),
  returning: z.string().optional().describe('RETURNING clause to get back inserted/updated data'),
  schema: z.string().optional().default('public').describe('Schema name (defaults to public)')
});

type ExecuteMutationInput = z.infer<typeof ExecuteMutationInputSchema>;

async function executeMutation(
  input: ExecuteMutationInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ operation: string; rowsAffected: number; returning?: unknown[] }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { operation, table, data, where, conflictColumns, returning, schema } = input;

  try {
    await db.connect(resolvedConnectionString);
    
    const schemaPrefix = (schema && schema !== 'public') ? `"${schema}".` : '';
    const tableName = `${schemaPrefix}"${table}"`;

    switch (operation) {
      case 'insert': {
        if (!data || Object.keys(data).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'Data object is required for insert operation');
        }

        const columns = Object.keys(data);
        const values = Object.values(data);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        
        let insertSQL = `INSERT INTO ${tableName} (${columns.map(col => `"${col}"`).join(', ')}) VALUES (${placeholders})`;
        
        if (returning) {
          insertSQL += ` RETURNING ${returning}`;
        }

        const result = await db.query(insertSQL, values);
        return {
          operation: 'insert',
          rowsAffected: Array.isArray(result) ? result.length : 1,
          returning: returning ? result : undefined
        };
      }

      case 'update': {
        if (!data || Object.keys(data).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'Data object is required for update operation');
        }
        if (!where) {
          throw new McpError(ErrorCode.InvalidParams, 'WHERE clause is required for update operation to prevent accidental full table updates');
        }

        const columns = Object.keys(data);
        const values = Object.values(data);
        const setClause = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ');
        
        let updateSQL = `UPDATE ${tableName} SET ${setClause} WHERE ${where}`;
        
        if (returning) {
          updateSQL += ` RETURNING ${returning}`;
        }

        const result = await db.query(updateSQL, values);
        return {
          operation: 'update',
          rowsAffected: Array.isArray(result) ? result.length : 1,
          returning: returning ? result : undefined
        };
      }

      case 'delete': {
        if (!where) {
          throw new McpError(ErrorCode.InvalidParams, 'WHERE clause is required for delete operation to prevent accidental full table deletion');
        }

        let deleteSQL = `DELETE FROM ${tableName} WHERE ${where}`;
        
        if (returning) {
          deleteSQL += ` RETURNING ${returning}`;
        }

        const result = await db.query(deleteSQL);
        return {
          operation: 'delete',
          rowsAffected: Array.isArray(result) ? result.length : 1,
          returning: returning ? result : undefined
        };
      }

      case 'upsert': {
        if (!data || Object.keys(data).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'Data object is required for upsert operation');
        }
        if (!conflictColumns || conflictColumns.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'Conflict columns are required for upsert operation');
        }

        const columns = Object.keys(data);
        const values = Object.values(data);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        const conflictCols = conflictColumns.map(col => `"${col}"`).join(', ');
        const updateClause = columns
          .filter(col => !conflictColumns.includes(col))
          .map(col => `"${col}" = EXCLUDED."${col}"`)
          .join(', ');
        
        let upsertSQL = `INSERT INTO ${tableName} (${columns.map(col => `"${col}"`).join(', ')}) VALUES (${placeholders}) ON CONFLICT (${conflictCols})`;
        
        if (updateClause) {
          upsertSQL += ` DO UPDATE SET ${updateClause}`;
        } else {
          upsertSQL += ' DO NOTHING';
        }
        
        if (returning) {
          upsertSQL += ` RETURNING ${returning}`;
        }

        const result = await db.query(upsertSQL, values);
        return {
          operation: 'upsert',
          rowsAffected: Array.isArray(result) ? result.length : 1,
          returning: returning ? result : undefined
        };
      }

      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown operation: ${operation}`);
    }
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to execute ${operation}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const executeMutationTool: PostgresTool = {
  name: 'pg_execute_mutation',
  description: 'Execute data modification operations (INSERT/UPDATE/DELETE/UPSERT) - operation="insert/update/delete/upsert" with table and data. Examples: operation="insert", table="users", data={"name":"John","email":"john@example.com"}. Use when the user wants to pg execute mutation. Unlike pg_execute_query, pg_execute_sql, this tool specifically handles pg execute mutation.',
  inputSchema: ExecuteMutationInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const { 
      connectionString: connStringArg,
      operation,
      table,
      data,
      where,
      conflictColumns,
      returning,
      schema
    } = args as {
      connectionString?: string;
      operation: 'insert' | 'update' | 'delete' | 'upsert';
      table: string;
      data?: Record<string, unknown>;
      where?: string;
      conflictColumns?: string[];
      returning?: string;
      schema?: string;
    };

    const resolvedConnString = getConnectionStringVal(connStringArg);

    try {
      // Input validation
      if (!table?.trim()) {
        return { 
          content: [{ type: 'text', text: 'Error: table is required' }], 
          isError: true 
        };
      }

      const result = await executeMutation({
        connectionString: resolvedConnString,
        operation,
        table,
        data,
        where,
        conflictColumns,
        returning,
        schema: schema || 'public'
      } as ExecuteMutationInput, getConnectionStringVal);

      let responseText = `${operation.toUpperCase()} operation completed successfully. Rows affected: ${result.rowsAffected}`;
      
      if (result.returning && result.returning.length > 0) {
        responseText += `\n\nReturning data:\n${JSON.stringify(result.returning, null, 2)}`;
      }

      return { content: [{ type: 'text', text: responseText }] };

    } catch (error) {
      return { 
        content: [{ type: 'text', text: `Error executing ${operation} operation: ${error instanceof Error ? error.message : String(error)}` }], 
        isError: true 
      };
    }
  }
};

// ===== EXECUTE SQL TOOL (Arbitrary SQL execution) =====

const ExecuteSqlInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  sql: z.string().describe('SQL statement to execute (can be any valid PostgreSQL SQL)'),
  parameters: z.array(z.unknown()).optional().default([]).describe('Parameter values for prepared statement placeholders ($1, $2, etc.)'),
  expectRows: z.boolean().optional().default(true).describe('Whether to expect rows back (false for statements like CREATE, DROP, etc.)'),
  timeout: z.number().optional().describe('Query timeout in milliseconds'),
  transactional: z.boolean().optional().default(false).describe('Whether to wrap in a transaction')
});

type ExecuteSqlInput = z.infer<typeof ExecuteSqlInputSchema>;

async function executeSql(
  input: ExecuteSqlInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ sql: string; rowsAffected?: number; rows?: unknown[]; message: string }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { sql, parameters, expectRows, timeout, transactional } = input;

  try {
    await db.connect(resolvedConnectionString);
    
    const queryOptions = timeout ? { timeout } : {};

    if (transactional) {
      return await db.transaction(async (client) => {
        const result = await client.query(sql, parameters || []);
        
        if (expectRows) {
          return {
            sql,
            rowsAffected: Array.isArray(result.rows) ? result.rows.length : 0,
            rows: result.rows,
            message: `SQL executed successfully in transaction. Retrieved ${Array.isArray(result.rows) ? result.rows.length : 0} rows.`
          };
        }
        return {
          sql,
          rowsAffected: result.rowCount || 0,
          message: `SQL executed successfully in transaction. Rows affected: ${result.rowCount || 0}`
        };
      });
    }
    const result = await db.query(sql, parameters || [], queryOptions);
    
    if (expectRows) {
      return {
        sql,
        rowsAffected: Array.isArray(result) ? result.length : 0,
        rows: result,
        message: `SQL executed successfully. Retrieved ${Array.isArray(result) ? result.length : 0} rows.`
      };
    }
    return {
      sql,
      rowsAffected: Array.isArray(result) ? result.length : 1,
      message: 'SQL executed successfully. Operation completed.'
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to execute SQL: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const executeSqlTool: PostgresTool = {
  name: 'pg_execute_sql',
  description: 'Execute arbitrary SQL statements - sql="ANY_VALID_SQL" with optional parameters and transaction support. Examples: sql="CREATE INDEX ...", sql="WITH complex_cte AS (...) SELECT ...", transactional=true. Use when the user wants to pg execute sql. Unlike pg_execute_query, pg_execute_mutation, this tool specifically handles pg execute sql.',
  inputSchema: ExecuteSqlInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const { 
      connectionString: connStringArg,
      sql,
      parameters,
      expectRows,
      timeout,
      transactional
    } = args as {
      connectionString?: string;
      sql: string;
      parameters?: unknown[];
      expectRows?: boolean;
      timeout?: number;
      transactional?: boolean;
    };

    const resolvedConnString = getConnectionStringVal(connStringArg);

    try {
      // Input validation
      if (!sql?.trim()) {
        return { 
          content: [{ type: 'text', text: 'Error: sql is required' }], 
          isError: true 
        };
      }

      const result = await executeSql({
        connectionString: resolvedConnString,
        sql,
        parameters: parameters ?? [],
        expectRows: expectRows ?? true,
        timeout,
        transactional: transactional ?? false
      }, getConnectionStringVal);

      let responseText = result.message;
      
      if (result.rows && result.rows.length > 0) {
        responseText += `\n\nResults:\n${JSON.stringify(result.rows, null, 2)}`;
      }

      return { content: [{ type: 'text', text: responseText }] };

    } catch (error) {
      return { 
        content: [{ type: 'text', text: `Error executing SQL: ${error instanceof Error ? error.message : String(error)}` }], 
        isError: true 
      };
    }
  }
}; 