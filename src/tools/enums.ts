import { z } from 'zod';
// Remove direct import of sql from @vercel/postgres
// import { sql } from '@vercel/postgres'; 
import { DatabaseConnection } from '../utils/connection.js'; // Use the custom connection wrapper
// Remove MCP specific type imports - rely on structural typing
// import type { MCPToolDefinition, MCPToolExecuteInput } from '../types.js';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

// Define return type structure similar to schema.ts

interface EnumInfo {
  enum_schema: string;
  enum_name: string;
  enum_values: string[];
}

const GetEnumsInputSchema = z.object({
  connectionString: z.string().optional(),
  schema: z.string().optional().default('public').describe('Schema name (defaults to public)'),
  enumName: z.string().optional().describe('Optional specific ENUM name to filter by'),
});

type GetEnumsInput = z.infer<typeof GetEnumsInputSchema>;

const CreateEnumInputSchema = z.object({
  connectionString: z.string().optional(),
  enumName: z.string().describe('Name of the ENUM type to create'),
  values: z.array(z.string()).min(1).describe('List of values for the ENUM type'),
  schema: z.string().optional().default('public').describe('Schema name (defaults to public)'),
  ifNotExists: z.boolean().optional().default(false).describe('Include IF NOT EXISTS clause'),
});

type CreateEnumInput = z.infer<typeof CreateEnumInputSchema>;

// Use inferred input type and expected Promise<EnumResult> return type
async function executeGetEnums(
  input: GetEnumsInput,
  getConnectionString: GetConnectionStringFn
): Promise<EnumInfo[]> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const { schema, enumName } = input;
  const db = DatabaseConnection.getInstance();
  try {
    await db.connect(resolvedConnectionString);
    let query = `
      SELECT 
          n.nspname as enum_schema,
          t.typname as enum_name, 
          array_agg(e.enumlabel ORDER BY e.enumsortorder) as enum_values
      FROM pg_type t 
      JOIN pg_enum e ON t.oid = e.enumtypid
      JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = $1 AND t.typtype = 'e'
    `;
    const params: (string | undefined)[] = [schema];

    if (enumName) {
      query += ' AND t.typname = $2';
      params.push(enumName);
    }

    query += ' GROUP BY n.nspname, t.typname ORDER BY n.nspname, t.typname;';

    const result = await db.query<EnumInfo>(query, params.filter(p => p !== undefined) as string[]); 
    
    return result;

  } catch (error) {
    console.error("Error fetching ENUMs:", error);
    throw new McpError(ErrorCode.InternalError, `Failed to fetch ENUMs: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

// Use inferred input type and expected Promise<EnumResult> return type
async function executeCreateEnum(
  input: CreateEnumInput, 
  getConnectionString: GetConnectionStringFn
): Promise<{ schema?: string; enumName: string; values: string[]}> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const { enumName, values, schema, ifNotExists } = input;
  const db = DatabaseConnection.getInstance();
  try {
    await db.connect(resolvedConnectionString);
    // Manually quote identifiers using double quotes
    const qualifiedSchema = `"${schema || 'public'}"`;
    const qualifiedEnumName = `"${enumName}"`;
    const fullEnumName = `${qualifiedSchema}.${qualifiedEnumName}`;
    // Use parameterized query for values and add explicit types to map
    const valuesPlaceholders = values.map((_: string, i: number) => `$${i + 1}`).join(', ');
    const ifNotExistsClause = ifNotExists ? 'IF NOT EXISTS' : '';

    const query = `CREATE TYPE ${ifNotExistsClause} ${fullEnumName} AS ENUM (${valuesPlaceholders});`;

    await db.query(query, values);
    return { schema, enumName, values };
  } catch (error) {
    console.error("Error creating ENUM:", error);
    throw new McpError(ErrorCode.InternalError, `Failed to create ENUM ${enumName}: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
      await db.disconnect();
  }
}

export const getEnumsTool: PostgresTool = {
  name: 'pg_get_enums',
  description: 'Get information about PostgreSQL ENUM types',
  inputSchema: GetEnumsInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = GetEnumsInputSchema.safeParse(params);
    if (!validationResult.success) {
      const errorDetails = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      return {
        content: [{ type: 'text', text: `Invalid input for getEnums: ${errorDetails}` }],
        isError: true,
      };
    }
    try {
      const enums = await executeGetEnums(validationResult.data, getConnectionString);
      return {
        content: [
          { type: 'text', text: `Fetched ${enums.length} ENUM(s).` },
          { type: 'text', text: JSON.stringify(enums, null, 2) }
        ],
      };
    } catch (error) {
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return {
        content: [{ type: 'text', text: `Error getting ENUMs: ${errorMessage}` }],
        isError: true,
      };
    }
  }
};

export const createEnumTool: PostgresTool = {
  name: 'pg_create_enum',
  description: 'Create a new ENUM type in the database',
  inputSchema: CreateEnumInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = CreateEnumInputSchema.safeParse(params);
    if (!validationResult.success) {
      const errorDetails = validationResult.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
      return {
        content: [{ type: 'text', text: `Invalid input for createEnum: ${errorDetails}` }],
        isError: true,
      };
    }
    try {
      const result = await executeCreateEnum(validationResult.data, getConnectionString);
      return {
        content: [
            { type: 'text', text: `ENUM type ${result.schema ? `${result.schema}.` : ''}${result.enumName} created successfully.` },
            { type: 'text', text: JSON.stringify(result, null, 2) }
        ],
      };
    } catch (error) {
        const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
        return {
            content: [{ type: 'text', text: `Error creating ENUM: ${errorMessage}` }],
            isError: true,
        };
    }
  }
};

// Potential future additions: dropEnum, alterEnumAddValue, alterEnumRenameValue 