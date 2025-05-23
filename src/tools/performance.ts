import { DatabaseConnection } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

interface ExplainResult {
  query: string;
  plan: object[];
  execution_time?: number;
  planning_time?: number;
  total_cost?: number;
  actual_rows?: number;
  estimated_rows?: number;
}

interface SlowQuery {
  query: string;
  calls: number;
  total_time: number;
  mean_time: number;
  rows: number;
  stddev_time: number;
  min_time: number;
  max_time: number;
  shared_blks_hit: number;
  shared_blks_read: number;
  shared_blks_written: number;
  temp_blks_read: number;
  temp_blks_written: number;
}

interface QueryStats {
  query_id: string;
  query: string;
  calls: number;
  total_time: number;
  mean_time: number;
  min_time: number;
  max_time: number;
  stddev_time: number;
  rows: number;
  shared_blks_hit: number;
  shared_blks_read: number;
  shared_blks_written: number;
  cache_hit_ratio: number;
}

// --- EXPLAIN Query Tool ---
const ExplainQueryInputSchema = z.object({
  connectionString: z.string().optional(),
  query: z.string().describe("SQL query to explain"),
  analyze: z.boolean().optional().default(false).describe("Use EXPLAIN ANALYZE (actually executes the query)"),
  buffers: z.boolean().optional().default(false).describe("Include buffer usage information"),
  verbose: z.boolean().optional().default(false).describe("Include verbose output"),
  costs: z.boolean().optional().default(true).describe("Include cost estimates"),
  format: z.enum(['text', 'json', 'xml', 'yaml']).optional().default('json').describe("Output format"),
});
type ExplainQueryInput = z.infer<typeof ExplainQueryInputSchema>;

async function executeExplainQuery(
  input: ExplainQueryInput,
  getConnectionString: GetConnectionStringFn
): Promise<ExplainResult> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { query, analyze, buffers, verbose, costs, format } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    // Build EXPLAIN options
    const options = [];
    if (analyze) options.push('ANALYZE');
    if (buffers) options.push('BUFFERS');
    if (verbose) options.push('VERBOSE');
    if (!costs) options.push('COSTS false');
    options.push(`FORMAT ${format.toUpperCase()}`);
    
    const explainQuery = `EXPLAIN (${options.join(', ')}) ${query}`;
    
    const result = await db.query(explainQuery);
    
    // Extract timing information if available (from EXPLAIN ANALYZE)
    let execution_time: number | undefined;
    let planning_time: number | undefined;
    let total_cost: number | undefined;
    let actual_rows: number | undefined;
    let estimated_rows: number | undefined;
    
    if (format === 'json' && result.length > 0) {
      const plan = result[0]['QUERY PLAN'];
      if (Array.isArray(plan) && plan.length > 0) {
        const planData = plan[0];
        execution_time = planData['Execution Time'];
        planning_time = planData['Planning Time'];
        
        if (planData.Plan) {
          total_cost = planData.Plan['Total Cost'];
          actual_rows = planData.Plan['Actual Rows'];
          estimated_rows = planData.Plan['Plan Rows'];
        }
      }
    }
    
    return {
      query,
      plan: result,
      execution_time,
      planning_time,
      total_cost,
      actual_rows,
      estimated_rows
    };
    
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to explain query: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const explainQueryTool: PostgresTool = {
  name: 'pg_explain_query',
  description: 'EXPLAIN/EXPLAIN ANALYZE for queries to understand execution plans',
  inputSchema: ExplainQueryInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = ExplainQueryInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeExplainQuery(validationResult.data, getConnectionString);
      const message = validationResult.data.analyze 
        ? 'Query execution plan with runtime statistics' 
        : 'Query execution plan';
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error explaining query: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Get Slow Queries Tool ---
const GetSlowQueriesInputSchema = z.object({
  connectionString: z.string().optional(),
  limit: z.number().optional().default(10).describe("Number of slow queries to return"),
  minDuration: z.number().optional().describe("Minimum average duration in milliseconds"),
  orderBy: z.enum(['mean_time', 'total_time', 'calls']).optional().default('mean_time').describe("Sort order"),
  includeNormalized: z.boolean().optional().default(true).describe("Include normalized query text"),
});
type GetSlowQueriesInput = z.infer<typeof GetSlowQueriesInputSchema>;

async function executeGetSlowQueries(
  input: GetSlowQueriesInput,
  getConnectionString: GetConnectionStringFn
): Promise<SlowQuery[]> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { limit, minDuration, orderBy, includeNormalized } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    // Check if pg_stat_statements extension is available
    const extensionCheck = await db.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'"
    );
    
    if (extensionCheck.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'pg_stat_statements extension is not installed. Please install it first: CREATE EXTENSION pg_stat_statements;');
    }
    
    const queryColumn = includeNormalized ? 'query' : 'query';
    const minDurationClause = minDuration ? `WHERE mean_time >= ${minDuration}` : '';
    
    const slowQueriesQuery = `
      SELECT 
        ${queryColumn},
        calls,
        total_time,
        mean_time,
        rows,
        stddev_time,
        min_time,
        max_time,
        shared_blks_hit,
        shared_blks_read,
        shared_blks_written,
        temp_blks_read,
        temp_blks_written
      FROM pg_stat_statements 
      ${minDurationClause}
      ORDER BY ${orderBy} DESC 
      LIMIT $1
    `;
    
    const result = await db.query<SlowQuery>(slowQueriesQuery, [limit]);
    return result;
    
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to get slow queries: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const getSlowQueriesTool: PostgresTool = {
  name: 'pg_get_slow_queries',
  description: 'Find slow running queries using pg_stat_statements',
  inputSchema: GetSlowQueriesInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = GetSlowQueriesInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeGetSlowQueries(validationResult.data, getConnectionString);
      const message = `Top ${validationResult.data.limit} slow queries ordered by ${validationResult.data.orderBy}`;
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error getting slow queries: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Get Query Stats Tool ---
const GetQueryStatsInputSchema = z.object({
  connectionString: z.string().optional(),
  limit: z.number().optional().default(20).describe("Number of queries to return"),
  orderBy: z.enum(['calls', 'total_time', 'mean_time', 'cache_hit_ratio']).optional().default('total_time').describe("Sort order"),
  minCalls: z.number().optional().describe("Minimum number of calls"),
  queryPattern: z.string().optional().describe("Filter queries containing this pattern"),
});
type GetQueryStatsInput = z.infer<typeof GetQueryStatsInputSchema>;

async function executeGetQueryStats(
  input: GetQueryStatsInput,
  getConnectionString: GetConnectionStringFn
): Promise<QueryStats[]> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { limit, orderBy, minCalls, queryPattern } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    // Check if pg_stat_statements extension is available
    const extensionCheck = await db.query(
      "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'"
    );
    
    if (extensionCheck.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, 'pg_stat_statements extension is not installed. Please install it first: CREATE EXTENSION pg_stat_statements;');
    }
    
    const whereConditions: string[] = [];
    const params: (number | string)[] = [limit];
    let paramIndex = 2;
    
    if (minCalls) {
      whereConditions.push(`calls >= $${paramIndex}`);
      params.push(minCalls);
      paramIndex++;
    }
    
    if (queryPattern) {
      whereConditions.push(`query ILIKE $${paramIndex}`);
      params.push(`%${queryPattern}%`);
      paramIndex++;
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const queryStatsQuery = `
      SELECT 
        queryid::text as query_id,
        query,
        calls,
        total_time,
        mean_time,
        min_time,
        max_time,
        stddev_time,
        rows,
        shared_blks_hit,
        shared_blks_read,
        shared_blks_written,
        CASE 
          WHEN (shared_blks_hit + shared_blks_read) = 0 THEN 0
          ELSE round((shared_blks_hit::numeric / (shared_blks_hit + shared_blks_read)::numeric) * 100, 2)
        END as cache_hit_ratio
      FROM pg_stat_statements 
      ${whereClause}
      ORDER BY ${orderBy} DESC 
      LIMIT $1
    `;
    
    const result = await db.query<QueryStats>(queryStatsQuery, params);
    return result;
    
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to get query statistics: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const getQueryStatsTool: PostgresTool = {
  name: 'pg_get_query_stats',
  description: 'Query statistics from pg_stat_statements with cache hit ratios',
  inputSchema: GetQueryStatsInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = GetQueryStatsInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeGetQueryStats(validationResult.data, getConnectionString);
      const message = `Query statistics ordered by ${validationResult.data.orderBy}`;
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error getting query statistics: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Reset Query Stats Tool ---
const ResetQueryStatsInputSchema = z.object({
  connectionString: z.string().optional(),
  queryId: z.string().optional().describe("Specific query ID to reset (optional, resets all if not provided)"),
});
type ResetQueryStatsInput = z.infer<typeof ResetQueryStatsInputSchema>;

async function executeResetQueryStats(
  input: ResetQueryStatsInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ message: string; queryId?: string }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { queryId } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    if (queryId) {
      await db.query('SELECT pg_stat_statements_reset($1)', [Number(queryId)]);
      return { message: `Query statistics reset for query ID: ${queryId}`, queryId };
    } 
    
    await db.query('SELECT pg_stat_statements_reset()');
    return { message: 'All query statistics have been reset' };
    
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to reset query statistics: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const resetQueryStatsTool: PostgresTool = {
  name: 'pg_reset_query_stats',
  description: 'Reset pg_stat_statements statistics (all or specific query)',
  inputSchema: ResetQueryStatsInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = ResetQueryStatsInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeResetQueryStats(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: result.message }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error resetting query statistics: ${errorMessage}` }], isError: true };
    }
  }
}; 