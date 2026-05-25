import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import {
  assertReadableSandboxFile,
  assertWritableContentSize,
  resolveSandboxPath
} from '../utils/filesystem.js';
import {
  buildWhereClause,
  quoteIdent,
  quoteQualifiedIdent,
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
const DEFAULT_EXPORT_ROW_LIMIT = 1000;
const MAX_EXPORT_ROW_LIMIT = 100000;
const DEFAULT_COPY_ROW_LIMIT = 1000;
const MAX_COPY_ROW_LIMIT = 100000;

function formatValidationError(error: z.ZodError): string {
  return error.errors.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join(', ');
}

function buildSelectQuery(
  tableName: string,
  schema: string,
  where: WherePredicate | string | undefined,
  rawWhere: string | undefined,
  limit?: number
): { query: string; params: unknown[] } {
  let query = `SELECT * FROM ${quoteQualifiedIdent(tableName, schema)}`;
  let params: unknown[] = [];

  if (rawWhere) {
    query += ` WHERE ${rawWhere}`;
  } else if (typeof where === 'string') {
    throw new McpError(ErrorCode.InvalidParams, 'String where predicates are not allowed. Use structured where predicates or rawWhere for trusted local/admin SQL.');
  } else if (where && Object.keys(where).length > 0) {
    const whereClause = buildWhereClause(where);
    query += ` WHERE ${whereClause.clause}`;
    params = whereClause.values;
  }

  if (limit !== undefined) {
    query += ` LIMIT $${params.length + 1}`;
    params.push(limit);
  }

  return { query, params };
}

function toInternalError(prefix: string, error: unknown): McpError {
  if (error instanceof McpError) {
    return error;
  }

  return new McpError(ErrorCode.InternalError, `${prefix}: ${sanitizeErrorMessage(error)}`);
}

function validateCsvDelimiter(delimiter: string | undefined): string {
  const csvDelimiter = delimiter ?? ',';

  if (csvDelimiter.length !== 1 || csvDelimiter === '"' || csvDelimiter === '\n' || csvDelimiter === '\r') {
    throw new McpError(ErrorCode.InvalidParams, 'CSV delimiter must be a single non-quote, non-newline character.');
  }

  return csvDelimiter;
}

function serializeCsvField(value: unknown, delimiter = ','): string {
  const stringValue = value === undefined ? '' : String(value);

  if (
    stringValue.includes(delimiter) ||
    stringValue.includes('"') ||
    stringValue.includes('\n') ||
    stringValue.includes('\r') ||
    stringValue !== stringValue.trim()
  ) {
    return `"${stringValue.replace(/"/g, '""')}"`;
  }

  return stringValue;
}

function serializeCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) {
    return '';
  }

  const headers = Object.keys(rows[0]);
  const outputRows = [
    headers.map(header => serializeCsvField(header)).join(','),
    ...rows.map(row => headers.map(header => serializeCsvField(row[header])).join(','))
  ];

  return outputRows.join('\n');
}

function parseCsv(fileContent: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let justClosedQuote = false;

  for (let index = 0; index < fileContent.length; index++) {
    const char = fileContent[index];
    const nextChar = fileContent[index + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          field += '"';
          index++;
        } else {
          inQuotes = false;
          justClosedQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      if (field.length === 0) {
        inQuotes = true;
        justClosedQuote = false;
        continue;
      }
      throw new Error('Invalid CSV: unexpected quote in unquoted field');
    }

    if (char === delimiter) {
      row.push(field);
      field = '';
      justClosedQuote = false;
      continue;
    }

    if (char === '\n' || char === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      justClosedQuote = false;

      if (char === '\r' && nextChar === '\n') {
        index++;
      }
      continue;
    }

    if (justClosedQuote) {
      if (char.trim() !== '') {
        throw new Error('Invalid CSV: unexpected content after closing quote');
      }
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new Error('Invalid CSV: unterminated quoted field');
  }

  if (field.length > 0 || row.length > 0 || fileContent.endsWith(delimiter)) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter(parsedRow => parsedRow.some(value => value.trim() !== ''));
}

function parseCsvRecords(fileContent: string, delimiter: string): Record<string, unknown>[] {
  const rows = parseCsv(fileContent, delimiter);

  if (rows.length === 0) {
    return [];
  }

  const [headers, ...dataRows] = rows;

  if (headers.some(header => header.length === 0)) {
    throw new Error('Invalid CSV: headers cannot be empty');
  }

  if (new Set(headers).size !== headers.length) {
    throw new Error('Invalid CSV: headers must be unique');
  }

  return dataRows.map((values, rowIndex) => {
    if (values.length > headers.length) {
      throw new Error(`Invalid CSV: row ${rowIndex + 2} has more values than headers`);
    }

    const record: Record<string, unknown> = {};

    for (let index = 0; index < headers.length; index++) {
      record[headers[index]] = values[index] !== undefined ? values[index] : null;
    }

    return record;
  });
}

function validateImportRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new Error('Input file does not contain an array of records');
  }

  return value.map((record, index) => {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error(`Import record at index ${index} must be a JSON object.`);
    }

    return record as Record<string, unknown>;
  });
}

// interface MigrationResult {
//   success: boolean;
//   message: string;
//   details: Record<string, unknown>;
// }

// --- ExportTableData Tool ---
const ExportTableDataInputSchema = z.object({
  connectionString: z.string().optional(),
  tableName: z.string(),
  schema: z.string().optional().default('public'),
  outputPath: z.string().describe("path under POSTGRES_MCP_WORKSPACE_DIR to save the exported data"),
  where: z.union([WherePredicateSchema, z.string()]).optional(),
  rawWhere: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_EXPORT_ROW_LIMIT).optional().default(DEFAULT_EXPORT_ROW_LIMIT),
  format: z.enum(['json', 'csv']).optional().default('json'),
}).strict();
type ExportTableDataInput = z.infer<typeof ExportTableDataInputSchema>;

async function executeExportTableData(
  input: ExportTableDataInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ tableName: string; rowCount: number; outputPath: string }> {
  const db = DatabaseConnection.getInstance();
  const { tableName, schema, outputPath, where, rawWhere, limit, format } = input;

  try {
    const resolvedOutputPath = resolveSandboxPath(outputPath, format);
    const selectQuery = buildSelectQuery(tableName, schema, where as WherePredicate | string | undefined, rawWhere, limit);
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    const data = await db.query<Record<string, unknown>>(selectQuery.query, selectQuery.params);

    let outputContent: string;

    if (format === 'csv') {
      outputContent = serializeCsv(data);
    } else {
      outputContent = JSON.stringify(data, null, 2);
    }

    assertWritableContentSize(outputContent);

    const dir = path.dirname(resolvedOutputPath);
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(resolvedOutputPath, outputContent);
    
    return {
        tableName: `${schema}.${tableName}`,
        rowCount: data.length,
        outputPath
    };
  } catch (error) {
    throw toInternalError('Failed to export data', error);
  } finally {
    await db.disconnect();
  }
}

export const exportTableDataTool: PostgresTool = {
  name: 'pg_export_table_data',
  description: 'Export table data to JSON or CSV format',
  inputSchema: ExportTableDataInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = ExportTableDataInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeExportTableData(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Successfully exported ${result.rowCount} rows from ${result.tableName} to ${result.outputPath}` }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error exporting data: ${errorMessage}` }], isError: true };
    }
  }
};


// --- ImportTableData Tool ---
const ImportTableDataInputSchema = z.object({
  connectionString: z.string().optional(),
  tableName: z.string(),
  schema: z.string().optional().default('public'),
  inputPath: z.string().describe("path under POSTGRES_MCP_WORKSPACE_DIR to the file to import"),
  truncateFirst: z.boolean().optional().default(false),
  format: z.enum(['json', 'csv']).optional().default('json'),
  delimiter: z.string().optional(),
}).strict();
type ImportTableDataInput = z.infer<typeof ImportTableDataInputSchema>;

async function executeImportTableData(
  input: ImportTableDataInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ tableName: string; rowCount: number }> {
  const db = DatabaseConnection.getInstance();
  const { tableName, schema, inputPath, truncateFirst, format, delimiter } = input;
  
  try {
    const quotedTableName = quoteQualifiedIdent(tableName, schema);
    const resolvedInputPath = await assertReadableSandboxFile(inputPath, format);
    const fileContent = await fs.promises.readFile(resolvedInputPath, 'utf8');
    
    let dataToImport: Record<string, unknown>[];
    
    if (format === 'csv') {
      dataToImport = parseCsvRecords(fileContent, validateCsvDelimiter(delimiter));
    } else {
      dataToImport = validateImportRecords(JSON.parse(fileContent));
    }

    const resolvedConnectionString = getConnectionString(input.connectionString);
    await db.connect(resolvedConnectionString);
    
    if (truncateFirst) {
      await db.query(`TRUNCATE TABLE ${quotedTableName}`);
    }
    
    let importedCount = 0;
    if (dataToImport.length > 0) {
      await db.transaction(async (client: import('pg').PoolClient) => {
        for (const record of dataToImport) {
          const columns = Object.keys(record);
          if (columns.length === 0) continue; // Skip empty records
          const values = Object.values(record);
          const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
          
          const query = `
            INSERT INTO ${quotedTableName} (${columns.map(quoteIdent).join(', ')})
            VALUES (${placeholders})
          `;
          
          await client.query(query, values);
          importedCount++;
        }
      });
    }
    
    return {
        tableName: `${schema}.${tableName}`,
        rowCount: importedCount
    };
  } catch (error) {
    throw toInternalError('Failed to import data', error);
  } finally {
    await db.disconnect();
  }
}

export const importTableDataTool: PostgresTool = {
  name: 'pg_import_table_data',
  description: 'Import data from JSON or CSV file into a table',
  inputSchema: ImportTableDataInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = ImportTableDataInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeImportTableData(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Successfully imported ${result.rowCount} rows into ${result.tableName}` }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error importing data: ${errorMessage}` }], isError: true };
    }
  }
};

// --- CopyBetweenDatabases Tool ---
const CopyBetweenDatabasesInputSchema = z.object({
  sourceConnectionString: z.string(),
  targetConnectionString: z.string(),
  tableName: z.string(),
  schema: z.string().optional().default('public'),
  where: z.union([WherePredicateSchema, z.string()]).optional(),
  rawWhere: z.string().optional(),
  limit: z.number().int().min(1).max(MAX_COPY_ROW_LIMIT).optional().default(DEFAULT_COPY_ROW_LIMIT),
  truncateTarget: z.boolean().optional().default(false),
}).strict();
type CopyBetweenDatabasesInput = z.infer<typeof CopyBetweenDatabasesInputSchema>;

async function executeCopyBetweenDatabases(
  input: CopyBetweenDatabasesInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ tableName: string; rowCount: number }> {
  const { sourceConnectionString, targetConnectionString, tableName, schema, where, rawWhere, limit, truncateTarget } = input;
  
  const db = DatabaseConnection.getInstance(); // Use the singleton for both connections sequentially

  try {
    const quotedTableName = quoteQualifiedIdent(tableName, schema);
    const selectQuery = buildSelectQuery(tableName, schema, where as WherePredicate | string | undefined, rawWhere, limit);
    const resolvedSourceConnectionString = getConnectionString(sourceConnectionString);
    const resolvedTargetConnectionString = getConnectionString(targetConnectionString);

    // --- Source Operations ---
    await db.connect(resolvedSourceConnectionString);
    const data = await db.query<Record<string, unknown>>(selectQuery.query, selectQuery.params);
    
    if (data.length === 0) {
      await db.disconnect(); // Disconnect source if no data
      return { tableName: `${schema}.${tableName}`, rowCount: 0 };
    }
    
    await db.disconnect(); // Disconnect source before connecting to target
    
    // --- Target Operations ---
    await db.connect(resolvedTargetConnectionString);
    
    if (truncateTarget) {
      await db.query(`TRUNCATE TABLE ${quotedTableName}`);
    }
    
    let importedCount = 0;
    await db.transaction(async (client: import('pg').PoolClient) => {
      for (const record of data) {
        const columns = Object.keys(record);
        if (columns.length === 0) continue;
        const values = Object.values(record);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        
        const insertQuery = `
          INSERT INTO ${quotedTableName} (${columns.map(quoteIdent).join(', ')})
          VALUES (${placeholders})
        `;
        await client.query(insertQuery, values);
        importedCount++;
      }
    });
    
    return { tableName: `${schema}.${tableName}`, rowCount: importedCount };
  } catch (error) {
    throw toInternalError('Failed to copy data', error);
  } finally {
    // Ensure disconnection in normal flow; connect() handles prior disconnects if needed.
    // The connect method in DatabaseConnection already handles disconnecting if connected to a different DB.
    // So, a single disconnect here should be fine, assuming the last active connection was target.
    // If an error occurred mid-operation (e.g., after source connect, before target connect),
    // connect() for target would handle disconnecting from source.
    // If an error occurs after target connect, this disconnect handles target.
    await db.disconnect(); 
  }
}

export const copyBetweenDatabasesTool: PostgresTool = {
  name: 'pg_copy_between_databases',
  description: 'Copy data between two databases',
  inputSchema: CopyBetweenDatabasesInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = CopyBetweenDatabasesInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeCopyBetweenDatabases(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Successfully copied ${result.rowCount} rows to ${result.tableName}` }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error copying data: ${errorMessage}` }], isError: true };
    }
  }
};

// Removed old function exports
// export async function exportTableData(...)
// export async function importTableData(...)
// export async function copyBetweenDatabases(...)
