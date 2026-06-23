import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  buildStaticWhereClause,
  quoteIdent,
  quoteQualifiedIdent,
  redactSqlText,
  type WherePredicate
} from '../utils/sql.js';

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

interface IndexInfo {
  schemaname: string;
  tablename: string;
  indexname: string;
  indexdef: string;
  size: string;
  scans: number;
  tuples_read: number;
  tuples_fetched: number;
}

interface IndexUsageStats {
  schemaname: string;
  tablename: string;
  indexname: string;
  scans: number;
  tuples_read: number;
  tuples_fetched: number;
  size_bytes: number;
  size_pretty: string;
  is_unique: boolean;
  is_primary: boolean;
  usage_ratio: number;
}

function toInternalError(prefix: string, error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }

  return new McpError(ErrorCode.InternalError, `${prefix}: ${sanitizeErrorMessage(error)}`);
}

function formatValidationError(error: z.ZodError): string {
  return error.errors.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join(', ');
}

// --- Get Indexes Tool ---
const GetIndexesInputSchema = z.object({
  connectionString: z.string().optional(),
  schema: z.string().optional().default('public').describe("Schema name"),
  tableName: z.string().optional().describe("Optional table name to filter indexes"),
  includeStats: z.boolean().optional().default(true).describe("Include usage statistics"),
}).strict();
type GetIndexesInput = z.infer<typeof GetIndexesInputSchema>;

async function executeGetIndexes(
  input: GetIndexesInput,
  getConnectionString: GetConnectionStringFn
): Promise<IndexInfo[] | IndexUsageStats[]> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { schema, tableName, includeStats } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    if (includeStats) {
      const statsQuery = `
        SELECT 
          schemaname,
          tablename,
          indexname,
          idx_scan as scans,
          idx_tup_read as tuples_read,
          idx_tup_fetch as tuples_fetched,
          pg_relation_size(indexrelname::regclass) as size_bytes,
          pg_size_pretty(pg_relation_size(indexrelname::regclass)) as size_pretty,
          indisunique as is_unique,
          indisprimary as is_primary,
          CASE 
            WHEN idx_scan = 0 THEN 0
            ELSE round((idx_tup_fetch::numeric / idx_tup_read::numeric) * 100, 2)
          END as usage_ratio
        FROM pg_stat_user_indexes psi
        JOIN pg_index pi ON psi.indexrelid = pi.indexrelid
        WHERE schemaname = $1 
          ${tableName ? 'AND tablename = $2' : ''}
        ORDER BY size_bytes DESC, scans DESC
      `;
      
      const params = tableName ? [schema, tableName] : [schema];
      const results = await db.query<IndexUsageStats>(statsQuery, params);
      return results;
    }
    
    const basicQuery = `
      SELECT 
        schemaname,
        tablename,
        indexname,
        indexdef,
        pg_size_pretty(pg_relation_size(indexname::regclass)) as size
      FROM pg_indexes 
      WHERE schemaname = $1 
        ${tableName ? 'AND tablename = $2' : ''}
      ORDER BY tablename, indexname
    `;
    
    const params = tableName ? [schema, tableName] : [schema];
    const results = await db.query<IndexInfo>(basicQuery, params);
    return results.map((row) => ({
      ...row,
      indexdef: redactSqlText(row.indexdef)
    }));
  } catch (error) {
    throw toInternalError('Failed to get indexes', error);
  } finally {
    await db.disconnect();
  }
}

export const getIndexesTool: PostgresTool = {
  name: 'pg_get_indexes',
  description: 'List indexes with size and usage statistics',
  inputSchema: GetIndexesInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = GetIndexesInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeGetIndexes(validationResult.data, getConnectionString);
      const message = validationResult.data.tableName 
        ? `Indexes for table ${validationResult.data.tableName}` 
        : `Indexes in schema ${validationResult.data.schema}`;
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error getting indexes: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Create Index Tool ---
const CreateIndexInputSchema = z.object({
  connectionString: z.string().optional(),
  indexName: z.string().describe("Name of the index to create"),
  tableName: z.string().describe("Table to create index on"),
  columns: z.array(z.string()).min(1).describe("Column names for the index"),
  schema: z.string().optional().default('public').describe("Schema name"),
  unique: z.boolean().optional().default(false).describe("Create unique index"),
  concurrent: z.boolean().optional().default(false).describe("Create index concurrently"),
  method: z.enum(['btree', 'hash', 'gist', 'spgist', 'gin', 'brin']).optional().default('btree').describe("Index method"),
  where: z.union([WherePredicateSchema, z.string()]).optional().describe("Structured WHERE predicate for partial index. Legacy string predicates are unsafe."),
  rawWhere: z.string().optional().describe("Unsafe raw WHERE SQL clause for trusted local/admin use only"),
  ifNotExists: z.boolean().optional().default(true).describe("Include IF NOT EXISTS clause"),
}).strict();
type CreateIndexInput = z.infer<typeof CreateIndexInputSchema>;

async function executeCreateIndex(
  input: CreateIndexInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ indexName: string; tableName: string; schema: string; columnCount: number; predicateSet: boolean; created: true }> {
  const db = DatabaseConnection.getInstance();
  const { indexName, tableName, columns, schema, unique, concurrent, method, where, rawWhere, ifNotExists } = input;

  try {
    const qualifiedIndexName = quoteQualifiedIdent(indexName, schema);
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const uniqueClause = unique ? 'UNIQUE ' : '';
    const concurrentClause = concurrent ? 'CONCURRENTLY ' : '';
    const ifNotExistsClause = ifNotExists ? 'IF NOT EXISTS ' : '';
    const columnsClause = columns.map(quoteIdent).join(', ');
    const methodClause = method !== 'btree' ? ` USING ${method}` : '';
    if (where && typeof where === 'string') {
      throw new McpError(ErrorCode.InvalidParams, 'String where predicates are not allowed. Use structured where predicates or rawWhere for trusted local/admin SQL.');
    }
    const whereClause = rawWhere
      ? ` WHERE ${rawWhere}`
      : where && typeof where !== 'string'
        ? ` WHERE ${buildStaticWhereClause(where as WherePredicate)}`
        : where
          ? ` WHERE ${where}`
          : '';

    const createIndexSQL = `CREATE ${uniqueClause}INDEX ${concurrentClause}${ifNotExistsClause}${qualifiedIndexName} ON ${qualifiedTableName}${methodClause} (${columnsClause})${whereClause}`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(createIndexSQL);

    return {
      indexName,
      tableName,
      schema,
      columnCount: columns.length,
      predicateSet: Boolean(whereClause),
      created: true
    };
  } catch (error) {
    throw toInternalError('Failed to create index', error);
  } finally {
    await db.disconnect();
  }
}

export const createIndexTool: PostgresTool = {
  name: 'pg_create_index',
  description: 'Create a new index on a table',
  inputSchema: CreateIndexInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = CreateIndexInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeCreateIndex(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Index ${result.indexName} created successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error creating index: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Drop Index Tool ---
const DropIndexInputSchema = z.object({
  connectionString: z.string().optional(),
  indexName: z.string().describe("Name of the index to drop"),
  schema: z.string().optional().default('public').describe("Schema name"),
  concurrent: z.boolean().optional().default(false).describe("Drop index concurrently"),
  ifExists: z.boolean().optional().default(true).describe("Include IF EXISTS clause"),
  cascade: z.boolean().optional().default(false).describe("Include CASCADE clause"),
}).strict();
type DropIndexInput = z.infer<typeof DropIndexInputSchema>;

async function executeDropIndex(
  input: DropIndexInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ indexName: string; schema: string }> {
  const db = DatabaseConnection.getInstance();
  const { indexName, schema, concurrent, ifExists, cascade } = input;

  try {
    const qualifiedIndexName = quoteQualifiedIdent(indexName, schema);
    const concurrentClause = concurrent ? 'CONCURRENTLY ' : '';
    const ifExistsClause = ifExists ? 'IF EXISTS ' : '';
    const cascadeClause = cascade ? ' CASCADE' : '';

    const dropIndexSQL = `DROP INDEX ${concurrentClause}${ifExistsClause}${qualifiedIndexName}${cascadeClause}`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(dropIndexSQL);

    return { indexName, schema };
  } catch (error) {
    throw toInternalError('Failed to drop index', error);
  } finally {
    await db.disconnect();
  }
}

export const dropIndexTool: PostgresTool = {
  name: 'pg_drop_index',
  description: 'Drop an existing index',
  inputSchema: DropIndexInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = DropIndexInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeDropIndex(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Index ${result.indexName} dropped successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error dropping index: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Reindex Tool ---
const ReindexInputSchema = z.object({
  connectionString: z.string().optional(),
  target: z.string().describe("Index name, table name, or schema name to reindex"),
  type: z.enum(['index', 'table', 'schema', 'database']).describe("Type of target to reindex"),
  schema: z.string().optional().default('public').describe("Schema name (for table/index targets)"),
  concurrent: z.boolean().optional().default(false).describe("Reindex concurrently (PostgreSQL 12+)"),
}).strict();
type ReindexInput = z.infer<typeof ReindexInputSchema>;

async function executeReindex(
  input: ReindexInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ target: string; type: string; schema?: string }> {
  const db = DatabaseConnection.getInstance();
  const { target, type, schema, concurrent } = input;

  try {
    let reindexSQL = '';
    const concurrentClause = concurrent ? ' CONCURRENTLY' : '';

    switch (type) {
      case 'index': {
        reindexSQL = `REINDEX${concurrentClause} INDEX ${quoteQualifiedIdent(target, schema)}`;
        break;
      }
      case 'table': {
        reindexSQL = `REINDEX${concurrentClause} TABLE ${quoteQualifiedIdent(target, schema)}`;
        break;
      }
      case 'schema':
        reindexSQL = `REINDEX${concurrentClause} SCHEMA ${quoteIdent(target)}`;
        break;
      case 'database':
        reindexSQL = `REINDEX${concurrentClause} DATABASE ${quoteIdent(target)}`;
        break;
    }

    const resolvedConnectionString = getConnectionString(input.connectionString);
    await db.connect(resolvedConnectionString);
    await db.query(reindexSQL);

    return { target, type, schema };
  } catch (error) {
    throw toInternalError('Failed to reindex', error);
  } finally {
    await db.disconnect();
  }
}

export const reindexTool: PostgresTool = {
  name: 'pg_reindex',
  description: 'Rebuild indexes to improve performance and reclaim space',
  inputSchema: ReindexInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = ReindexInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeReindex(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Reindex completed successfully for ${result.type} ${result.target}.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error during reindex: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Analyze Index Usage Tool ---
const AnalyzeIndexUsageInputSchema = z.object({
  connectionString: z.string().optional(),
  schema: z.string().optional().default('public').describe("Schema name"),
  tableName: z.string().optional().describe("Optional table name to filter"),
  minSizeBytes: z.number().min(0).optional().describe("Minimum index size in bytes to include"),
  showUnused: z.boolean().optional().default(true).describe("Include indexes with zero scans"),
  showDuplicates: z.boolean().optional().default(true).describe("Detect potentially duplicate indexes"),
}).strict();
type AnalyzeIndexUsageInput = z.infer<typeof AnalyzeIndexUsageInputSchema>;

interface IndexAnalysis {
  unused_indexes: IndexUsageStats[];
  duplicate_indexes: Array<{
    table_name: string;
    columns: string;
    indexes: string[];
  }>;
  low_usage_indexes: IndexUsageStats[];
  statistics: {
    total_indexes: number;
    unused_count: number;
    duplicate_groups: number;
    total_size_bytes: number;
    total_size_pretty: string;
    unused_size_bytes: number;
    unused_size_pretty: string;
  };
}

async function executeAnalyzeIndexUsage(
  input: AnalyzeIndexUsageInput,
  getConnectionString: GetConnectionStringFn
): Promise<IndexAnalysis> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { schema, tableName, minSizeBytes = 0, showUnused, showDuplicates } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    // Get all index usage stats
    const usageQuery = `
      SELECT 
        schemaname,
        tablename,
        indexname,
        idx_scan as scans,
        idx_tup_read as tuples_read,
        idx_tup_fetch as tuples_fetched,
        pg_relation_size(indexrelname::regclass) as size_bytes,
        pg_size_pretty(pg_relation_size(indexrelname::regclass)) as size_pretty,
        indisunique as is_unique,
        indisprimary as is_primary,
        CASE 
          WHEN idx_scan = 0 THEN 0
          ELSE round((idx_tup_fetch::numeric / NULLIF(idx_tup_read::numeric, 0)) * 100, 2)
        END as usage_ratio
      FROM pg_stat_user_indexes psi
      JOIN pg_index pi ON psi.indexrelid = pi.indexrelid
      WHERE schemaname = $1 
        ${tableName ? 'AND tablename = $2' : ''}
        AND pg_relation_size(indexrelname::regclass) >= $${tableName ? '3' : '2'}
        AND NOT indisprimary  -- Exclude primary key indexes from analysis
      ORDER BY size_bytes DESC
    `;
    
    const params = tableName ? [schema, tableName, minSizeBytes] : [schema, minSizeBytes];
    const allIndexes = await db.query<IndexUsageStats>(usageQuery, params);
    
    const unused_indexes = showUnused ? allIndexes.filter(idx => idx.scans === 0) : [];
    const low_usage_indexes = allIndexes.filter(idx => idx.scans > 0 && idx.scans < 10);
    
    let duplicate_indexes: Array<{ table_name: string; columns: string; indexes: string[] }> = [];
    
    if (showDuplicates) {
      // Find potentially duplicate indexes by comparing column definitions
      const duplicateQuery = `
        SELECT 
          schemaname,
          tablename,
          array_agg(indexname) as index_names,
          string_agg(pg_get_indexdef(indexrelid), ' | ') as definitions,
          count(*) as index_count
        FROM pg_stat_user_indexes psi
        JOIN pg_index pi ON psi.indexrelid = pi.indexrelid
        WHERE schemaname = $1 
          ${tableName ? 'AND tablename = $2' : ''}
          AND NOT indisprimary
        GROUP BY schemaname, tablename, indkey
        HAVING count(*) > 1
      `;
      
      const duplicateResults = await db.query<{
        schemaname: string;
        tablename: string;
        index_names: string[];
        definitions: string;
        index_count: number;
      }>(duplicateQuery, tableName ? [schema, tableName] : [schema]);
      
      duplicate_indexes = duplicateResults.map(row => ({
        table_name: row.tablename,
        columns: redactSqlText(row.definitions),
        indexes: row.index_names
      }));
    }
    
    const totalSizeBytes = allIndexes.reduce((sum, idx) => sum + idx.size_bytes, 0);
    const unusedSizeBytes = unused_indexes.reduce((sum, idx) => sum + idx.size_bytes, 0);
    
    return {
      unused_indexes,
      duplicate_indexes,
      low_usage_indexes,
      statistics: {
        total_indexes: allIndexes.length,
        unused_count: unused_indexes.length,
        duplicate_groups: duplicate_indexes.length,
        total_size_bytes: totalSizeBytes,
        total_size_pretty: await formatBytes(db, totalSizeBytes),
        unused_size_bytes: unusedSizeBytes,
        unused_size_pretty: await formatBytes(db, unusedSizeBytes),
      }
    };
    
  } catch (error) {
    throw toInternalError('Failed to analyze index usage', error);
  } finally {
    await db.disconnect();
  }
}

async function formatBytes(db: DatabaseConnection, bytes: number): Promise<string> {
  const result = await db.query<{ formatted: string }>('SELECT pg_size_pretty($1::bigint) as formatted', [bytes]);
  return result[0]?.formatted || '0 bytes';
}

export const analyzeIndexUsageTool: PostgresTool = {
  name: 'pg_analyze_index_usage',
  description: 'Find unused, duplicate, and low-usage indexes to optimize database performance',
  inputSchema: AnalyzeIndexUsageInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = AnalyzeIndexUsageInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeAnalyzeIndexUsage(validationResult.data, getConnectionString);
      const message = validationResult.data.tableName 
        ? `Index usage analysis for table ${validationResult.data.tableName}` 
        : `Index usage analysis for schema ${validationResult.data.schema}`;
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error analyzing index usage: ${errorMessage}` }], isError: true };
    }
  }
};

const ManageIndexesInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['get', 'create', 'drop', 'reindex', 'analyze_usage']).describe('Operation: get (list indexes), create (new index), drop (remove index), reindex (rebuild), analyze_usage (find unused/duplicate)'),

  // Common parameters
  schema: z.string().optional().describe('Schema name (defaults to public)'),
  tableName: z.string().optional().describe('Table name (optional for get/analyze_usage, required for create)'),
  indexName: z.string().optional().describe('Index name (required for create/drop)'),

  // Get operation parameters
  includeStats: z.boolean().optional().describe('Include usage statistics (for get operation)'),

  // Create operation parameters
  columns: z.array(z.string()).optional().describe('Column names for the index (required for create operation)'),
  unique: z.boolean().optional().describe('Create unique index (for create operation)'),
  concurrent: z.boolean().optional().describe('Create/drop index concurrently (for create/drop operations)'),
  method: z.enum(['btree', 'hash', 'gist', 'spgist', 'gin', 'brin']).optional().describe('Index method (for create operation, defaults to btree)'),
  where: z.union([WherePredicateSchema, z.string()]).optional().describe('Structured WHERE predicate for partial index (for create operation). Legacy string predicates are unsafe.'),
  rawWhere: z.string().optional().describe('Unsafe raw WHERE SQL clause for trusted local/admin use only'),
  ifNotExists: z.boolean().optional().describe('Include IF NOT EXISTS clause (for create operation)'),

  // Drop operation parameters
  ifExists: z.boolean().optional().describe('Include IF EXISTS clause (for drop operation)'),
  cascade: z.boolean().optional().describe('Include CASCADE clause (for drop operation)'),

  // Reindex operation parameters
  target: z.string().optional().describe('Target name for reindex (required for reindex operation)'),
  type: z.enum(['index', 'table', 'schema', 'database']).optional().describe('Type of target for reindex (required for reindex operation)'),

  // Analyze usage parameters
  minSizeBytes: z.number().min(0).optional().describe('Minimum index size in bytes (for analyze_usage operation)'),
  showUnused: z.boolean().optional().describe('Include unused indexes (for analyze_usage operation)'),
  showDuplicates: z.boolean().optional().describe('Detect duplicate indexes (for analyze_usage operation)')
}).strict();

// Consolidated Index Management Tool
export const manageIndexesTool: PostgresTool = {
  name: 'pg_manage_indexes',
  description: 'Manage PostgreSQL indexes - get, create, drop, reindex, and analyze usage with a single tool. Examples: operation="get" to list indexes, operation="create" with indexName, tableName, columns, operation="analyze_usage" for performance analysis',
  inputSchema: ManageIndexesInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ManageIndexesInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const {
      connectionString: connStringArg,
      operation,
      schema,
      tableName,
      indexName,
      includeStats,
      columns,
      unique,
      concurrent,
      method,
      where,
      rawWhere,
      ifNotExists,
      ifExists,
      cascade,
      target,
      type,
      minSizeBytes,
      showUnused,
      showDuplicates
    } = validationResult.data;

    try {
      switch (operation) {
        case 'get': {
          const result = await executeGetIndexes({
            connectionString: connStringArg,
            schema: schema ?? 'public',
            tableName,
            includeStats: includeStats ?? true
          }, getConnectionStringVal);
          const message = tableName 
            ? `Indexes for table ${tableName}` 
            : `Indexes in schema ${schema ?? 'public'}`;
          return { content: [{ type: 'text', text: `${message}\n${JSON.stringify(result, null, 2)}` }] };
        }

        case 'create': {
          if (!indexName || !tableName || !columns || columns.length === 0) {
            return { 
              content: [{ type: 'text', text: 'Error: indexName, tableName, and columns are required for create operation' }], 
              isError: true 
            };
          }
          const result = await executeCreateIndex({
            connectionString: connStringArg,
            indexName,
            tableName,
            columns,
            schema: schema ?? 'public',
            unique: unique ?? false,
            concurrent: concurrent ?? false,
            method: method ?? 'btree',
            where,
            rawWhere,
            ifNotExists: ifNotExists ?? true
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Index ${result.indexName} created successfully. Details: ${JSON.stringify(result)}` }] };
        }

        case 'drop': {
          if (!indexName) {
            return { 
              content: [{ type: 'text', text: 'Error: indexName is required for drop operation' }], 
              isError: true 
            };
          }
          const result = await executeDropIndex({
            connectionString: connStringArg,
            indexName,
            schema: schema ?? 'public',
            concurrent: concurrent ?? false,
            ifExists: ifExists ?? true,
            cascade: cascade ?? false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Index ${result.indexName} dropped successfully. Details: ${JSON.stringify(result)}` }] };
        }

        case 'reindex': {
          if (!target || !type) {
            return { 
              content: [{ type: 'text', text: 'Error: target and type are required for reindex operation' }], 
              isError: true 
            };
          }
          const result = await executeReindex({
            connectionString: connStringArg,
            target,
            type,
            schema: schema ?? 'public',
            concurrent: concurrent ?? false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Reindex completed successfully for ${result.type} ${result.target}. Details: ${JSON.stringify(result)}` }] };
        }

        case 'analyze_usage': {
          const result = await executeAnalyzeIndexUsage({
            connectionString: connStringArg,
            schema: schema ?? 'public',
            tableName,
            minSizeBytes,
            showUnused: showUnused ?? true,
            showDuplicates: showDuplicates ?? true
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return { 
            content: [{ type: 'text', text: `Error: Unknown operation "${operation}". Supported operations: get, create, drop, reindex, analyze_usage` }], 
            isError: true 
          };
      }

    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { 
        content: [{ type: 'text', text: `Error executing ${operation} operation: ${errorMessage}` }], 
        isError: true 
      };
    }
  }
};
