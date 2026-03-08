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

const ManageQueryInputSchema = z.object({
  operation: z.enum(['explain', 'get_slow_queries', 'get_stats', 'reset_stats']).describe(
    'Operation: explain (EXPLAIN/EXPLAIN ANALYZE query), get_slow_queries (find slow queries from pg_stat_statements), get_stats (query statistics with cache hit ratios), reset_stats (reset pg_stat_statements)'
  ),
  connectionString: z.string().optional(),
  
  // EXPLAIN operation parameters
  query: z.string().optional().describe('SQL query to explain (required for explain operation)'),
  analyze: z.boolean().optional().default(false).describe('Use EXPLAIN ANALYZE - actually executes the query (for explain operation)'),
  buffers: z.boolean().optional().default(false).describe('Include buffer usage information (for explain operation)'),
  verbose: z.boolean().optional().default(false).describe('Include verbose output (for explain operation)'),
  costs: z.boolean().optional().default(true).describe('Include cost estimates (for explain operation)'),
  format: z.enum(['text', 'json', 'xml', 'yaml']).optional().default('json').describe('Output format (for explain operation)'),
  
  // GET_SLOW_QUERIES operation parameters
  limit: z.number().optional().default(10).describe('Number of slow queries to return (for get_slow_queries operation)'),
  minDuration: z.number().optional().describe('Minimum average duration in milliseconds (for get_slow_queries operation)'),
  orderBy: z.enum(['mean_time', 'total_time', 'calls', 'cache_hit_ratio']).optional().default('mean_time').describe('Sort order (for get_slow_queries and get_stats operations)'),
  includeNormalized: z.boolean().optional().default(true).describe('Include normalized query text (for get_slow_queries operation)'),
  
  // GET_STATS operation parameters
  minCalls: z.number().optional().describe('Minimum number of calls (for get_stats operation)'),
  queryPattern: z.string().optional().describe('Filter queries containing this pattern (for get_stats operation)'),
  
  // RESET_STATS operation parameters
  queryId: z.string().optional().describe('Specific query ID to reset (for reset_stats operation, resets all if not provided)'),
});

type ManageQueryInput = z.infer<typeof ManageQueryInputSchema>;

async function executeExplainQuery(
  input: ManageQueryInput,
  getConnectionString: GetConnectionStringFn
): Promise<ExplainResult> {
  if (!input.query) {
    throw new McpError(ErrorCode.InvalidParams, 'query parameter is required for explain operation');
  }

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
    options.push(`FORMAT ${format?.toUpperCase()}`);
    
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

async function executeGetSlowQueries(
  input: ManageQueryInput,
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
    const orderByColumn = orderBy === 'cache_hit_ratio' ? 'mean_time' : orderBy || 'mean_time'; // fallback for unsupported column
    
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
      ORDER BY ${orderByColumn} DESC 
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

async function executeGetQueryStats(
  input: ManageQueryInput,
  getConnectionString: GetConnectionStringFn
): Promise<QueryStats[]> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { limit, orderBy, minCalls, queryPattern } = input;
  const statsLimit = limit || 20; // Default for stats operation
  
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
    const params: (number | string)[] = [statsLimit];
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
    const orderByColumn = orderBy || 'total_time';
    
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
      ORDER BY ${orderByColumn} DESC 
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

async function executeResetQueryStats(
  input: ManageQueryInput,
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

async function executeManageQuery(
  input: ManageQueryInput,
  getConnectionString: GetConnectionStringFn
): Promise<ExplainResult | SlowQuery[] | QueryStats[] | { message: string; queryId?: string }> {
  switch (input.operation) {
    case 'explain':
      return executeExplainQuery(input, getConnectionString);
      
    case 'get_slow_queries':
      return executeGetSlowQueries(input, getConnectionString);
      
    case 'get_stats':
      return executeGetQueryStats(input, getConnectionString);
      
    case 'reset_stats':
      return executeResetQueryStats(input, getConnectionString);
      
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unsupported operation: ${input.operation}`);
  }
}

export const manageQueryTool: PostgresTool = {
  name: 'pg_manage_query',
  description: 'Manage PostgreSQL query analysis and performance - operation="explain" for EXPLAIN plans, operation="get_slow_queries" for slow query analysis, operation="get_stats" for query statistics, operation="reset_stats" for clearing statistics. Use when the user wants to extract specific data using a structured query. Unlike pg_manage_comments, pg_manage_constraints, this tool specifically handles pg manage query.',
  inputSchema: ManageQueryInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = ManageQueryInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { 
        content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], 
        isError: true 
      };
    }

    try {
      const result = await executeManageQuery(validationResult.data, getConnectionString);
      
      let message: string;
      switch (validationResult.data.operation) {
        case 'explain':
          message = validationResult.data.analyze 
            ? 'Query execution plan with runtime statistics' 
            : 'Query execution plan';
          break;
        case 'get_slow_queries':
          message = `Top ${validationResult.data.limit || 10} slow queries ordered by ${validationResult.data.orderBy || 'mean_time'}`;
          break;
        case 'get_stats':
          message = `Query statistics ordered by ${validationResult.data.orderBy || 'total_time'}`;
          break;
        case 'reset_stats':
          message = (result as { message: string }).message;
          break;
        default:
          message = 'Query operation completed';
      }
      
      return { 
        content: [
          { type: 'text', text: message }, 
          { type: 'text', text: JSON.stringify(result, null, 2) }
        ] 
      };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { 
        content: [{ type: 'text', text: `Error in query operation: ${errorMessage}` }], 
        isError: true 
      };
    }
  }
}; 