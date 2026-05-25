import { z } from 'zod';
import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { PostgresTool, ToolOutput, GetConnectionStringFn } from '../types/tool.js';
import {
  buildReturningClause,
  buildWhereClause,
  getReadOnlySqlValidationError,
  hasSqlStatementSeparator,
  quoteIdent,
  quoteQualifiedIdent,
  type WherePredicate
} from '../utils/sql.js';

// ===== EXECUTE QUERY TOOL (SELECT operations) =====

const DEFAULT_QUERY_LIMIT = 100;
const MAX_QUERY_LIMIT = 1000;
const DEFAULT_OUTPUT_ROW_LIMIT = 100;
const MAX_OUTPUT_ROW_LIMIT = 1000;

interface LimitedRows {
  rows: unknown[];
  totalRows: number;
  truncated: boolean;
}

const ExecuteQueryInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['select', 'count', 'exists']).describe('Query operation: select (fetch rows), count (count rows), exists (check existence)'),
  query: z.string().describe('SQL SELECT query to execute'),
  parameters: z.array(z.unknown()).optional().default([]).describe('Parameter values for prepared statement placeholders ($1, $2, etc.)'),
  limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional().default(DEFAULT_QUERY_LIMIT).describe(`Maximum number of rows to return for select operations (default ${DEFAULT_QUERY_LIMIT}, max ${MAX_QUERY_LIMIT})`),
  timeout: z.number().int().positive().optional().describe('Query timeout in milliseconds')
}).strict();
type ExecuteQueryInput = z.infer<typeof ExecuteQueryInputSchema>;
type QueryConfigWithTimeout = { text: string; values: unknown[]; timeout?: number };

function createQueryConfig(text: string, values: unknown[], timeout?: number): QueryConfigWithTimeout {
  const config: QueryConfigWithTimeout = { text, values };
  if (timeout !== undefined) {
    config.timeout = timeout;
  }
  return config;
}

function limitOutputRows(rows: unknown[], maxRows: number): LimitedRows {
  return {
    rows: rows.slice(0, maxRows),
    totalRows: rows.length,
    truncated: rows.length > maxRows
  };
}

async function executeQuery(
  input: ExecuteQueryInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ operation: string; rowCount: number; rows?: unknown[]; result?: unknown }> {
  const db = DatabaseConnection.getInstance();
  const { operation, query, parameters, limit, timeout } = input;

  try {
    const normalizedQuery = query.trim().replace(/;\s*$/, '');
    const validationError = getReadOnlySqlValidationError(normalizedQuery);
    if (validationError) {
      throw new McpError(ErrorCode.InvalidParams, validationError);
    }

    const resolvedConnectionString = getConnectionString(input.connectionString);
    await db.connect(resolvedConnectionString);

    const queryParams = parameters || [];

    switch (operation) {
      case 'select': {
        const limitPlaceholder = `$${queryParams.length + 1}`;
        const finalQuery = `SELECT * FROM (${normalizedQuery}) AS mcp_query LIMIT ${limitPlaceholder}`;
        return await db.transaction(async (client) => {
          const result = await client.query(createQueryConfig(finalQuery, [...queryParams, limit], timeout));
          return {
            operation: 'select',
            rowCount: result.rows.length,
            rows: result.rows
          };
        }, { readOnly: true });
      }

      case 'count': {
        // Wrap the query in a COUNT to get total rows
        const countQuery = `SELECT COUNT(*) as total FROM (${normalizedQuery}) as subquery`;
        return await db.transaction(async (client) => {
          const result = await client.query<{ total: number }>(createQueryConfig(countQuery, queryParams, timeout));
          return {
            operation: 'count',
            rowCount: 1,
            result: result.rows[0]?.total || 0
          };
        }, { readOnly: true });
      }

      case 'exists': {
        // Wrap the query in an EXISTS check
        const existsQuery = `SELECT EXISTS (${normalizedQuery}) as exists`;
        return await db.transaction(async (client) => {
          const result = await client.query<{ exists: boolean }>(createQueryConfig(existsQuery, queryParams, timeout));
          return {
            operation: 'exists',
            rowCount: 1,
            result: result.rows[0]?.exists || false
          };
        }, { readOnly: true });
      }

      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown operation: ${operation}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, `Failed to execute query: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const executeQueryTool: PostgresTool = {
  name: 'pg_execute_query',
  description: 'Execute SELECT queries and data retrieval operations - operation="select/count/exists" with query and optional parameters. Examples: operation="select", query="SELECT * FROM users WHERE created_at > $1", parameters=["2024-01-01"]',
  inputSchema: ExecuteQueryInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ExecuteQueryInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorDetails = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      return {
        content: [{ type: 'text', text: `Invalid input: ${errorDetails}` }],
        isError: true,
      };
    }

    const { connectionString: connStringArg, operation, query, parameters, limit, timeout } = validationResult.data;

    try {
      // Input validation
      if (!query?.trim()) {
        return { 
          content: [{ type: 'text', text: 'Error: query is required' }], 
          isError: true 
        };
      }

      const result = await executeQuery({
        connectionString: connStringArg,
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
      const errorMessage = sanitizeErrorMessage(error);
      return {
        content: [{ type: 'text', text: `Error executing ${operation} query: ${errorMessage}` }],
        isError: true
      };
    }
  }
};

// ===== EXECUTE MUTATION TOOL (INSERT/UPDATE/DELETE operations) =====

const SqlScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const WhereOperatorSchema = z.object({
  eq: SqlScalarSchema.optional(),
  ne: SqlScalarSchema.optional(),
  gt: SqlScalarSchema.optional(),
  gte: SqlScalarSchema.optional(),
  lt: SqlScalarSchema.optional(),
  lte: SqlScalarSchema.optional(),
  like: z.string().optional(),
  ilike: z.string().optional(),
  in: z.array(SqlScalarSchema).optional(),
  isNull: z.boolean().optional()
}).strict().refine((value) => Object.values(value).filter((item) => item !== undefined).length === 1, {
  message: 'Each where predicate must specify exactly one operator'
});
const WherePredicateSchema = z.record(z.union([SqlScalarSchema, WhereOperatorSchema]));

const ExecuteMutationInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['insert', 'update', 'delete', 'upsert']).describe('Mutation operation: insert (add rows), update (modify rows), delete (remove rows), upsert (insert or update)'),
  table: z.string().describe('Table name for the operation'),
  data: z.record(z.unknown()).optional().describe('Data object with column-value pairs (required for insert/update/upsert)'),
  where: z.union([WherePredicateSchema, z.string()]).optional().describe('Structured WHERE predicate for update/delete operations. Legacy string WHERE clauses are rejected; use rawWhere only for trusted local/admin SQL.'),
  rawWhere: z.string().optional().describe('Unsafe raw WHERE SQL clause for trusted local/admin use only'),
  conflictColumns: z.array(z.string()).optional().describe('Columns for conflict resolution in upsert (ON CONFLICT)'),
  returning: z.union([z.literal('*'), z.string(), z.array(z.string())]).optional().describe('Columns to return. Use "*" or an array/string list of column names; SQL expressions are rejected.'),
  maxReturningRows: z.number().int().min(1).max(MAX_OUTPUT_ROW_LIMIT).optional().default(DEFAULT_OUTPUT_ROW_LIMIT).describe(`Maximum number of RETURNING rows to include in the MCP response (default ${DEFAULT_OUTPUT_ROW_LIMIT}, max ${MAX_OUTPUT_ROW_LIMIT})`),
  schema: z.string().optional().default('public').describe('Schema name (defaults to public)')
}).strict();

type ExecuteMutationInput = z.infer<typeof ExecuteMutationInputSchema>;

interface MutationResult {
  operation: string;
  rowsAffected: number;
  returning?: unknown[];
  totalReturningRows?: number;
  returningTruncated?: boolean;
}

function buildMutationResult(
  operation: string,
  result: { rowCount: number | null; rows: unknown[] },
  returning: ExecuteMutationInput['returning'],
  maxReturningRows: number
): MutationResult {
  const baseResult: MutationResult = {
    operation,
    rowsAffected: result.rowCount ?? result.rows.length
  };

  if (!returning) {
    return baseResult;
  }

  const limited = limitOutputRows(result.rows, maxReturningRows);
  return {
    ...baseResult,
    returning: limited.rows,
    totalReturningRows: limited.totalRows,
    returningTruncated: limited.truncated
  };
}

async function executeMutation(
  input: ExecuteMutationInput,
  getConnectionString: GetConnectionStringFn
): Promise<MutationResult> {
  const db = DatabaseConnection.getInstance();
  const { operation, table, data, where, rawWhere, conflictColumns, returning, maxReturningRows, schema } = input;

  try {
    const tableName = quoteQualifiedIdent(table, schema);
    const returningClause = buildReturningClause(returning);
    const buildMutationWhere = (startingPlaceholder: number): { clause: string; values: unknown[] } => {
      if (rawWhere) {
        return { clause: rawWhere, values: [] };
      }

      if (!where) {
        throw new McpError(ErrorCode.InvalidParams, `WHERE predicate is required for ${operation} operation to prevent accidental full table changes`);
      }

      if (typeof where === 'string') {
        throw new McpError(ErrorCode.InvalidParams, 'String where predicates are not allowed. Use structured where predicates or rawWhere for trusted local/admin SQL.');
      }

      return buildWhereClause(where as WherePredicate, startingPlaceholder);
    };

    let sql: string;
    let queryValues: unknown[];

    switch (operation) {
      case 'insert': {
        if (!data || Object.keys(data).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'Data object is required for insert operation');
        }

        const columns = Object.keys(data);
        const values = Object.values(data);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');

        sql = `INSERT INTO ${tableName} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders})${returningClause}`;
        queryValues = values;
        break;
      }

      case 'update': {
        if (!data || Object.keys(data).length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'Data object is required for update operation');
        }
        const columns = Object.keys(data);
        const values = Object.values(data);
        const setClause = columns.map((col, i) => `${quoteIdent(col)} = $${i + 1}`).join(', ');
        const whereClause = buildMutationWhere(values.length + 1);
        sql = `UPDATE ${tableName} SET ${setClause} WHERE ${whereClause.clause}${returningClause}`;
        queryValues = [...values, ...whereClause.values];
        break;
      }

      case 'delete': {
        const whereClause = buildMutationWhere(1);
        sql = `DELETE FROM ${tableName} WHERE ${whereClause.clause}${returningClause}`;
        queryValues = whereClause.values;
        break;
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
        const conflictCols = conflictColumns.map(quoteIdent).join(', ');
        const updateClause = columns
          .filter(col => !conflictColumns.includes(col))
          .map(col => `${quoteIdent(col)} = EXCLUDED.${quoteIdent(col)}`)
          .join(', ');

        sql = `INSERT INTO ${tableName} (${columns.map(quoteIdent).join(', ')}) VALUES (${placeholders}) ON CONFLICT (${conflictCols})`;

        if (updateClause) {
          sql += ` DO UPDATE SET ${updateClause}`;
        } else {
          sql += ' DO NOTHING';
        }

        sql += returningClause;
        queryValues = values;
        break;
      }

      default:
        throw new McpError(ErrorCode.InvalidParams, `Unknown operation: ${operation}`);
    }

    const resolvedConnectionString = getConnectionString(input.connectionString);
    await db.connect(resolvedConnectionString);
    const result = await db.queryResult(sql, queryValues);
    return buildMutationResult(operation, result, returning, maxReturningRows);
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, `Failed to execute ${operation}: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const executeMutationTool: PostgresTool = {
  name: 'pg_execute_mutation',
  description: 'Execute data modification operations (INSERT/UPDATE/DELETE/UPSERT) - operation="insert/update/delete/upsert" with table and data. Examples: operation="insert", table="users", data={"name":"John","email":"john@example.com"}',
  inputSchema: ExecuteMutationInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ExecuteMutationInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorDetails = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      return {
        content: [{ type: 'text', text: `Invalid input: ${errorDetails}` }],
        isError: true,
      };
    }

    const { connectionString: connStringArg, operation, table } = validationResult.data;

    try {
      // Input validation
      if (!table?.trim()) {
        return { 
          content: [{ type: 'text', text: 'Error: table is required' }], 
          isError: true 
        };
      }

      const result = await executeMutation({
        ...validationResult.data,
        connectionString: connStringArg
      }, getConnectionStringVal);

      let responseText = `${operation.toUpperCase()} operation completed successfully. Rows affected: ${result.rowsAffected}`;

      if (result.returning && result.returning.length > 0) {
        if (result.returningTruncated) {
          responseText += `\n\nReturning data truncated to ${result.returning.length} of ${result.totalReturningRows} rows.`;
        }
        responseText += `\n\nReturning data:\n${JSON.stringify(result.returning, null, 2)}`;
      }

      return { content: [{ type: 'text', text: responseText }] };

    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return {
        content: [{ type: 'text', text: `Error executing ${operation} operation: ${errorMessage}` }],
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
  timeout: z.number().int().positive().optional().describe('Query timeout in milliseconds'),
  maxRows: z.number().int().min(1).max(MAX_OUTPUT_ROW_LIMIT).optional().default(DEFAULT_OUTPUT_ROW_LIMIT).describe(`Maximum number of result rows to include in the MCP response (default ${DEFAULT_OUTPUT_ROW_LIMIT}, max ${MAX_OUTPUT_ROW_LIMIT})`),
  transactional: z.boolean().optional().default(false).describe('Whether to wrap in a transaction')
}).strict();
type ExecuteSqlInput = z.infer<typeof ExecuteSqlInputSchema>;

function validateArbitrarySqlExecutionShape(input: ExecuteSqlInput): void {
  const hasMultipleStatements = hasSqlStatementSeparator(input.sql);

  if (!hasMultipleStatements) {
    return;
  }

  if (!input.transactional) {
    throw new McpError(ErrorCode.InvalidParams, 'Multi-statement arbitrary SQL must use transactional=true to avoid partial execution.');
  }

  if (input.expectRows) {
    throw new McpError(ErrorCode.InvalidParams, 'Multi-statement arbitrary SQL must use expectRows=false because result sets are ambiguous.');
  }

  if ((input.parameters ?? []).length > 0) {
    throw new McpError(ErrorCode.InvalidParams, 'Multi-statement arbitrary SQL cannot use parameters. Use a single parameterized statement or inline trusted admin SQL.');
  }
}

async function executeSql(
  input: ExecuteSqlInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ sql: string; rowsAffected?: number; rows?: unknown[]; message: string; totalRows?: number; truncated?: boolean }> {
  const db = DatabaseConnection.getInstance();
  const { sql, parameters, expectRows, timeout, maxRows, transactional } = input;

  try {
    validateArbitrarySqlExecutionShape(input);
    const resolvedConnectionString = getConnectionString(input.connectionString);
    await db.connect(resolvedConnectionString);

    const queryOptions = timeout ? { timeout } : {};

    if (transactional) {
      return await db.transaction(async (client) => {
        const result = await client.query(createQueryConfig(sql, parameters || [], timeout));

        if (expectRows) {
          const limited = limitOutputRows(result.rows, maxRows);
          return {
            sql,
            rowsAffected: Array.isArray(result.rows) ? result.rows.length : 0,
            rows: limited.rows,
            totalRows: limited.totalRows,
            truncated: limited.truncated,
            message: limited.truncated
              ? `SQL executed successfully in transaction. Retrieved ${limited.totalRows} rows; returning first ${limited.rows.length}.`
              : `SQL executed successfully in transaction. Retrieved ${limited.totalRows} rows.`
          };
        }
        return {
          sql,
          rowsAffected: result.rowCount || 0,
          message: `SQL executed successfully in transaction. Rows affected: ${result.rowCount || 0}`
        };
      });
    }
    const result = await db.queryResult(sql, parameters || [], queryOptions);

    if (expectRows) {
      const limited = limitOutputRows(result.rows, maxRows);
      return {
        sql,
        rowsAffected: result.rows.length,
        rows: limited.rows,
        totalRows: limited.totalRows,
        truncated: limited.truncated,
        message: limited.truncated
          ? `SQL executed successfully. Retrieved ${limited.totalRows} rows; returning first ${limited.rows.length}.`
          : `SQL executed successfully. Retrieved ${limited.totalRows} rows.`
      };
    }
    return {
      sql,
      rowsAffected: result.rowCount ?? 0,
      message: `SQL executed successfully. Rows affected: ${result.rowCount ?? 0}`
    };
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, `Failed to execute SQL: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const executeSqlTool: PostgresTool = {
  name: 'pg_execute_sql',
  description: 'Execute arbitrary SQL statements - sql="ANY_VALID_SQL" with optional parameters and transaction support. Examples: sql="CREATE INDEX ...", sql="WITH complex_cte AS (...) SELECT ...", transactional=true',
  inputSchema: ExecuteSqlInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ExecuteSqlInputSchema.safeParse(args);
    if (!validationResult.success) {
      const errorDetails = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      return {
        content: [{ type: 'text', text: `Invalid input: ${errorDetails}` }],
        isError: true,
      };
    }

    const { connectionString: connStringArg, sql } = validationResult.data;

    try {
      // Input validation
      if (!sql?.trim()) {
        return {
          content: [{ type: 'text', text: 'Error: sql is required' }],
          isError: true
        };
      }

      validateArbitrarySqlExecutionShape(validationResult.data);

      const result = await executeSql({
        ...validationResult.data,
        connectionString: connStringArg
      }, getConnectionStringVal);

      let responseText = result.message;
      
      if (result.rows && result.rows.length > 0) {
        responseText += `\n\nResults:\n${JSON.stringify(result.rows, null, 2)}`;
      }

      return { content: [{ type: 'text', text: responseText }] };

    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return {
        content: [{ type: 'text', text: `Error executing SQL: ${errorMessage}` }],
        isError: true
      };
    }
  }
};
