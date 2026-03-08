import { DatabaseConnection } from '../utils/connection.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);
const mkdir = promisify(fs.mkdir);

// interface MigrationResult {
//   success: boolean;
//   message: string;
//   details: Record<string, unknown>;
// }

// --- ExportTableData Tool ---
const ExportTableDataInputSchema = z.object({
  connectionString: z.string().optional(),
  tableName: z.string(),
  outputPath: z.string().describe("absolute path to save the exported data"),
  where: z.string().optional(),
  limit: z.number().int().positive().optional(),
  format: z.enum(['json', 'csv']).optional().default('json'),
});
type ExportTableDataInput = z.infer<typeof ExportTableDataInputSchema>;

async function executeExportTableData(
  input: ExportTableDataInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ tableName: string; rowCount: number; outputPath: string }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { tableName, outputPath, where, limit, format } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    let query = `SELECT * FROM "${tableName}"`; // Consider quoting table name properly
    const params: unknown[] = [];
    
    if (where) {
      query += ` WHERE ${where}`; // SECURITY: Ensure 'where' is safe or validated if user-supplied
    }
    
    if (limit) {
      query += ` LIMIT ${limit}`;
    }
    
    const data = await db.query<Record<string, unknown>[]>(query, params);
    
    const dir = path.dirname(outputPath);
    // Use fs.promises.mkdir for cleaner async/await
    await fs.promises.mkdir(dir, { recursive: true });
    
    if (format === 'csv') {
      if (data.length === 0) {
        await fs.promises.writeFile(outputPath, '');
      } else {
        const headers = Object.keys(data[0]).join(',');
        const rows = data.map(row => 
          Object.values(row).map(value => {
            const stringValue = String(value); // Ensure value is a string
            return typeof value === 'string' ? `"${stringValue.replace(/"/g, '""')}"` : stringValue;
          }).join(',')
        );
        await fs.promises.writeFile(outputPath, [headers, ...rows].join('\n'));
      }
    } else {
      await fs.promises.writeFile(outputPath, JSON.stringify(data, null, 2));
    }
    
    return {
        tableName,
        rowCount: data.length,
        outputPath
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to export data: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const exportTableDataTool: PostgresTool = {
  name: 'pg_export_table_data',
  description: 'Export table data to JSON or CSV format. Use when the user wants to pg export table data. Unlike pg_import_table_data, pg_create_table, this tool specifically handles pg export table data.',
  inputSchema: ExportTableDataInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = ExportTableDataInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeExportTableData(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Successfully exported ${result.rowCount} rows from ${result.tableName} to ${result.outputPath}` }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error exporting data: ${errorMessage}` }], isError: true };
    }
  }
};


// --- ImportTableData Tool ---
const ImportTableDataInputSchema = z.object({
  connectionString: z.string().optional(),
  tableName: z.string(),
  inputPath: z.string().describe("absolute path to the file to import"),
  truncateFirst: z.boolean().optional().default(false),
  format: z.enum(['json', 'csv']).optional().default('json'),
  delimiter: z.string().optional(),
});
type ImportTableDataInput = z.infer<typeof ImportTableDataInputSchema>;

async function executeImportTableData(
  input: ImportTableDataInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ tableName: string; rowCount: number }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { tableName, inputPath, truncateFirst, format, delimiter } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    const fileContent = await fs.promises.readFile(inputPath, 'utf8');
    
    let dataToImport: Record<string, unknown>[];
    
    if (format === 'csv') {
      const csvDelimiter = delimiter || ',';
      const lines = fileContent.split('\n').filter(line => line.trim()); // Use \n consistently
      
      if (lines.length === 0) {
        return { tableName, rowCount: 0 };
      }
      
      const headers = lines[0].split(csvDelimiter).map(h => h.trim().replace(/^"|"$/g, '')); // Remove surrounding quotes from headers
      
      dataToImport = lines.slice(1).map(line => {
        // Basic CSV parsing, might need a more robust library for complex CSVs
        const values = line.split(csvDelimiter).map(val => val.trim().replace(/^"|"$/g, '').replace(/""/g, '"'));
        return headers.reduce((obj, header, index) => {
          obj[header] = values[index] !== undefined ? values[index] : null;
          return obj;
        }, {} as Record<string, unknown>);
      });
    } else {
      dataToImport = JSON.parse(fileContent);
    }
    
    if (!Array.isArray(dataToImport)) {
      throw new Error('Input file does not contain an array of records');
    }
    
    if (truncateFirst) {
      await db.query(`TRUNCATE TABLE "${tableName}"`); // Consider quoting
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
            INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')})
            VALUES (${placeholders})
          `;
          
          await client.query(query, values);
          importedCount++;
        }
      });
    }
    
    return {
        tableName,
        rowCount: importedCount
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to import data: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const importTableDataTool: PostgresTool = {
  name: 'pg_import_table_data',
  description: 'Import data from JSON or CSV file into a table. Use when the user wants to pg import table data. Unlike pg_export_table_data, pg_create_table, this tool specifically handles pg import table data.',
  inputSchema: ImportTableDataInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = ImportTableDataInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeImportTableData(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Successfully imported ${result.rowCount} rows into ${result.tableName}` }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error importing data: ${errorMessage}` }], isError: true };
    }
  }
};

// --- CopyBetweenDatabases Tool ---
const CopyBetweenDatabasesInputSchema = z.object({
  sourceConnectionString: z.string(),
  targetConnectionString: z.string(),
  tableName: z.string(),
  where: z.string().optional(),
  truncateTarget: z.boolean().optional().default(false),
});
type CopyBetweenDatabasesInput = z.infer<typeof CopyBetweenDatabasesInputSchema>;

async function executeCopyBetweenDatabases(
  input: CopyBetweenDatabasesInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ tableName: string; rowCount: number }> {
  const { sourceConnectionString, targetConnectionString, tableName, where, truncateTarget } = input;
  
  const db = DatabaseConnection.getInstance(); // Use the singleton for both connections sequentially

  try {
    // --- Source Operations ---
    await db.connect(sourceConnectionString);
    
    let query = `SELECT * FROM "${tableName}"`;
    if (where) {
      query += ` WHERE ${where}`;
    }
    
    const data = await db.query<Record<string, unknown>[]>(query);
    
    if (data.length === 0) {
      await db.disconnect(); // Disconnect source if no data
      return { tableName, rowCount: 0 };
    }
    
    await db.disconnect(); // Disconnect source before connecting to target
    
    // --- Target Operations ---
    await db.connect(targetConnectionString);
    
    if (truncateTarget) {
      await db.query(`TRUNCATE TABLE "${tableName}"`);
    }
    
    let importedCount = 0;
    await db.transaction(async (client: import('pg').PoolClient) => {
      for (const record of data) {
        const columns = Object.keys(record);
        if (columns.length === 0) continue;
        const values = Object.values(record);
        const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
        
        const insertQuery = `
          INSERT INTO "${tableName}" (${columns.map(c => `"${c}"`).join(', ')})
          VALUES (${placeholders})
        `;
        await client.query(insertQuery, values);
        importedCount++;
      }
    });
    
    return { tableName, rowCount: importedCount };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to copy data: ${error instanceof Error ? error.message : String(error)}`);
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
  description: 'Copy data between two databases. Use when the user wants to pg copy between databases.',
  inputSchema: CopyBetweenDatabasesInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = CopyBetweenDatabasesInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], isError: true };
    }
    try {
      const result = await executeCopyBetweenDatabases(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Successfully copied ${result.rowCount} rows to ${result.tableName}` }] };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { content: [{ type: 'text', text: `Error copying data: ${errorMessage}` }], isError: true };
    }
  }
};

// Removed old function exports
// export async function exportTableData(...)
// export async function importTableData(...)
// export async function copyBetweenDatabases(...) 