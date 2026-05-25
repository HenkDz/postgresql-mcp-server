import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import type { PoolClient } from 'pg'; // For transaction client type
import { buildCreateEnumTypeSql, quoteIdent, quoteQualifiedIdent, redactSqlText } from '../utils/sql.js';

interface SchemaResult {
  success: boolean;
  message: string;
  details: unknown;
}

interface TableInfo {
  schema: string;
  tableName: string;
  columns: ColumnInfo[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
}

interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
  default: string | null;
}

interface ConstraintInfo {
  name: string;
  type: string;
  definition: string;
}

interface IndexInfo {
  name: string;
  definition: string;
}

interface CreatedColumnInfo {
  name: string;
  type: string;
  nullable?: boolean;
  defaultSet: boolean;
}

interface AlteredColumnInfo {
  type: 'add' | 'alter' | 'drop';
  columnName: string;
  dataType?: string;
  nullable?: boolean;
  defaultChanged: boolean;
}

// Enum interfaces (from enums.ts)
interface EnumInfo {
  enum_schema: string;
  enum_name: string;
  enum_values: string[];
}

function formatValidationError(error: z.ZodError): string {
  return error.errors.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join(', ');
}

// --- GetSchemaInfo Tool ---
const GetSchemaInfoInputSchema = z.object({
  connectionString: z.string().optional(),
  schema: z.string().optional().default('public').describe("Schema name to inspect"),
  tableName: z.string().optional().describe("Optional table name to get detailed schema for"),
}).strict();
type GetSchemaInfoInput = z.infer<typeof GetSchemaInfoInputSchema>;

async function executeGetSchemaInfo(
  input: GetSchemaInfoInput,
  getConnectionString: GetConnectionStringFn
): Promise<TableInfo | string[]> { // Return type depends on whether tableName is provided
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { tableName, schema } = input;

  try {
    await db.connect(resolvedConnectionString);

    if (tableName) {
      return await getTableInfo(db, tableName, schema);
    }

    const tables = await db.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = $1 AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
      [schema]
    );
    return tables.map(t => t.table_name);

  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to get schema information: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const getSchemaInfoTool: PostgresTool = {
  name: 'pg_get_schema_info',
  description: 'Get schema information for a database or specific table',
  inputSchema: GetSchemaInfoInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = GetSchemaInfoInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeGetSchemaInfo(validationResult.data, getConnectionString);
      const schema = validationResult.data.schema;
      const message = validationResult.data.tableName
        ? `Schema information for table ${schema}.${validationResult.data.tableName}`
        : `List of tables in schema ${schema}`;
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error getting schema info: ${errorMessage}` }], isError: true };
    }
  }
};

// --- CreateTable Tool ---
const CreateTableColumnSchema = z.object({
  name: z.string(),
  type: z.string().describe("PostgreSQL data type"),
  nullable: z.boolean().optional(),
  default: z.string().optional().describe("Default value expression"),
  // primaryKey: z.boolean().optional(), // Consider adding PK constraint separately or via constraint tools
}).strict();

const CreateTableInputSchema = z.object({
  connectionString: z.string().optional(),
  tableName: z.string(),
  schema: z.string().optional().default('public'),
  columns: z.array(CreateTableColumnSchema).min(1),
  // primaryKeyColumns: z.array(z.string()).optional(), // Alternative for PKs
}).strict();
type CreateTableInput = z.infer<typeof CreateTableInputSchema>;

function validateDataType(dataType: string): string {
  const normalizedType = dataType.trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?(?:\s+[A-Za-z_][A-Za-z0-9_]*)*(?:\([0-9,\s]+\))?(?:\[\])?$/.test(normalizedType)) {
    throw new Error(`Invalid PostgreSQL data type "${dataType}". Use simple type names such as text, integer, numeric(10,2), timestamp with time zone, or schema.type.`);
  }

  if (normalizedType.includes('.')) {
    return normalizedType.split('.').map(quoteIdent).join('.');
  }

  return normalizedType;
}

function buildColumnDefinition(column: z.infer<typeof CreateTableColumnSchema>): string {
  let definition = `${quoteIdent(column.name)} ${validateDataType(column.type)}`;
  if (column.nullable === false) definition += ' NOT NULL';
  if (column.default !== undefined) definition += ` DEFAULT ${column.default}`;
  return definition;
}
async function executeCreateTable(
  input: CreateTableInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ tableName: string; schema: string; columnCount: number; columns: CreatedColumnInfo[] }> {
  const db = DatabaseConnection.getInstance();
  const { tableName, schema, columns } = input;

  try {
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const columnDefs = columns.map(buildColumnDefinition).join(', ');

    const createTableSQL = `CREATE TABLE IF NOT EXISTS ${qualifiedTableName} (${columnDefs})`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(createTableSQL);

    return {
      tableName,
      schema,
      columnCount: columns.length,
      columns: columns.map((column) => ({
        name: column.name,
        type: column.type,
        nullable: column.nullable,
        defaultSet: column.default !== undefined
      }))
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to create table: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const createTableTool: PostgresTool = {
  name: 'pg_create_table',
  description: 'Create a new table in the database',
  inputSchema: CreateTableInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = CreateTableInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeCreateTable(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Table ${result.tableName} created successfully (if not exists).` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error creating table: ${errorMessage}` }], isError: true };
    }
  }
};

// --- AlterTable Tool ---
const AlterTableOperationSchema = z.object({
  type: z.enum(['add', 'alter', 'drop']),
  columnName: z.string(),
  dataType: z.string().optional().describe("PostgreSQL data type (for add/alter)"),
  nullable: z.boolean().optional().describe("Whether the column can be NULL (for add/alter)"),
  default: z.string().optional().describe("Default value expression (for add/alter)"),
}).strict();

const AlterTableInputSchema = z.object({
  connectionString: z.string().optional(),
  tableName: z.string(),
  schema: z.string().optional().default('public'),
  operations: z.array(AlterTableOperationSchema).min(1),
}).strict();
type AlterTableInput = z.infer<typeof AlterTableInputSchema>;
async function executeAlterTable(
  input: AlterTableInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ tableName: string; operationCount: number; operations: AlteredColumnInfo[] }> {
  const db = DatabaseConnection.getInstance();
  const { tableName, schema, operations } = input;

  try {
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const statements: string[] = [];

    for (const op of operations) {
      const colNameQuoted = quoteIdent(op.columnName);

      switch (op.type) {
        case 'add':
          if (!op.dataType) throw new Error('Data type is required for ADD operation');
          let addColumnSql = `ALTER TABLE ${qualifiedTableName} ADD COLUMN ${colNameQuoted} ${validateDataType(op.dataType)}`;
          if (op.nullable === false) addColumnSql += ' NOT NULL';
          if (op.default !== undefined) addColumnSql += ` DEFAULT ${op.default}`;
          statements.push(addColumnSql);
          break;

        case 'alter': {
          let statementCount = 0;

          if (op.dataType) {
            statements.push(`ALTER TABLE ${qualifiedTableName} ALTER COLUMN ${colNameQuoted} TYPE ${validateDataType(op.dataType)}`);
            statementCount++;
          }

          if (op.nullable !== undefined) {
            statements.push(`ALTER TABLE ${qualifiedTableName} ALTER COLUMN ${colNameQuoted} ${op.nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
            statementCount++;
          }

          if (op.default !== undefined) {
            statements.push(`ALTER TABLE ${qualifiedTableName} ALTER COLUMN ${colNameQuoted} ${op.default === '' ? 'DROP DEFAULT' : `SET DEFAULT ${op.default}`}`);
            statementCount++;
          }

          if (statementCount === 0) {
            throw new Error('No alter operation specified for column.');
          }
          break;
        }

        case 'drop':
          statements.push(`ALTER TABLE ${qualifiedTableName} DROP COLUMN ${colNameQuoted}`);
          break;
      }
    }

    const resolvedConnectionString = getConnectionString(input.connectionString);
    await db.connect(resolvedConnectionString);
    await db.transaction(async (client: PoolClient) => {
      for (const sql of statements) {
        await client.query(sql);
      }
    });

    return {
      tableName,
      operationCount: operations.length,
      operations: operations.map((operation) => ({
        type: operation.type,
        columnName: operation.columnName,
        dataType: operation.dataType,
        nullable: operation.nullable,
        defaultChanged: operation.default !== undefined
      }))
    };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to alter table: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const alterTableTool: PostgresTool = {
  name: 'pg_alter_table',
  description: 'Alter an existing table (add/modify/drop columns)',
  inputSchema: AlterTableInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = AlterTableInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeAlterTable(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Table ${result.tableName} altered successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error altering table: ${errorMessage}` }], isError: true };
    }
  }
};

/**
 * Get detailed information about a specific table
 */
async function getTableInfo(db: DatabaseConnection, tableName: string, schema: string): Promise<TableInfo> {
  // Get column information
  const columns = await db.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [schema, tableName]
  );
  
  // Get constraint information
  const constraints = await db.query<{
    constraint_name: string;
    constraint_type: string;
    definition: string;
  }>(
    `SELECT
       c.conname as constraint_name,
       CASE
         WHEN c.contype = 'p' THEN 'PRIMARY KEY'
         WHEN c.contype = 'f' THEN 'FOREIGN KEY'
         WHEN c.contype = 'u' THEN 'UNIQUE'
         WHEN c.contype = 'c' THEN 'CHECK'
         ELSE c.contype::text
       END as constraint_type,
       pg_get_constraintdef(c.oid) as definition
     FROM pg_constraint c
     JOIN pg_namespace n ON n.oid = c.connamespace
     JOIN pg_class cl ON cl.oid = c.conrelid
     JOIN pg_namespace tn ON tn.oid = cl.relnamespace
     WHERE tn.nspname = $1 AND cl.relname = $2`,
    [schema, tableName]
  );
  
  // Get index information
  const indexes = await db.query<{
    indexname: string;
    indexdef: string;
  }>(
    `SELECT
       i.relname as indexname,
       pg_get_indexdef(i.oid) as indexdef
     FROM pg_index x
     JOIN pg_class c ON c.oid = x.indrelid
     JOIN pg_class i ON i.oid = x.indexrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = $1 AND c.relname = $2`,
    [schema, tableName]
  );

  return {
    schema,
    tableName,
    columns: columns.map(col => ({
      name: col.column_name,
      dataType: col.data_type,
      nullable: col.is_nullable === 'YES',
      default: col.column_default ? redactSqlText(col.column_default) : null
    })),
    constraints: constraints.map(con => ({
      name: con.constraint_name,
      type: con.constraint_type,
      definition: redactSqlText(con.definition)
    })),
    indexes: indexes.map(idx => ({
      name: idx.indexname,
      definition: redactSqlText(idx.indexdef)
    }))
  };
} 

// Enum functions (adapted from enums.ts)
async function executeGetEnumsInSchema(
  connectionString: string,
  schema = 'public',
  enumName?: string,
  getConnectionString?: GetConnectionStringFn
): Promise<EnumInfo[]> {
  const resolvedConnectionString = getConnectionString ? getConnectionString(connectionString) : connectionString;
  const db = DatabaseConnection.getInstance();
  try {
    await db.connect(resolvedConnectionString);
    let query = `
      SELECT 
          n.nspname as enum_schema,
          t.typname as enum_name, 
          array_agg(e.enumlabel::text ORDER BY e.enumsortorder) as enum_values
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
    throw new McpError(ErrorCode.InternalError, `Failed to fetch ENUMs: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

async function executeCreateEnumInSchema(
  connectionString: string,
  enumName: string,
  values: string[],
  schema = 'public',
  ifNotExists = false,
  getConnectionString?: GetConnectionStringFn
): Promise<{ schema: string; enumName: string; valueCount: number}> {
  const db = DatabaseConnection.getInstance();
  try {
    const query = buildCreateEnumTypeSql(enumName, values, schema, ifNotExists);
    const resolvedConnectionString = getConnectionString ? getConnectionString(connectionString) : connectionString;

    await db.connect(resolvedConnectionString);
    await db.query(query);
    return { schema, enumName, valueCount: values.length };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to create ENUM ${enumName}: ${sanitizeErrorMessage(error)}`);
  } finally {
      await db.disconnect();
  }
}

const ManageSchemaInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['get_info', 'create_table', 'alter_table', 'get_enums', 'create_enum']).describe('Operation: get_info (schema/table info), create_table (new table), alter_table (modify table), get_enums (list ENUMs), create_enum (new ENUM)'),

  // Common parameters
  tableName: z.string().optional().describe('Table name (optional for get_info to get specific table info, required for create_table/alter_table)'),
  schema: z.string().optional().describe('Schema name (defaults to public)'),

  // Create table parameters
  columns: z.array(CreateTableColumnSchema).optional().describe('Column definitions (required for create_table)'),

  // Alter table parameters
  operations: z.array(AlterTableOperationSchema).optional().describe('Alter operations (required for alter_table)'),

  // Enum parameters
  enumName: z.string().optional().describe('ENUM name (optional for get_enums to filter, required for create_enum)'),
  values: z.array(z.string()).optional().describe('ENUM values (required for create_enum)'),
  ifNotExists: z.boolean().optional().describe('Ignore duplicate type errors by wrapping CREATE TYPE in a DO block (for create_enum)')
}).strict();

// Complete Consolidated Schema Management Tool (covers all 5 operations)
export const manageSchemaTools: PostgresTool = {
  name: 'pg_manage_schema',
  description: 'Manage PostgreSQL schema - get schema info, create/alter tables, manage enums. Examples: operation="get_info" for table lists, operation="create_table" with tableName and columns, operation="get_enums" to list enums, operation="create_enum" with enumName and values',
  inputSchema: ManageSchemaInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ManageSchemaInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const {
      connectionString: connStringArg,
      operation,
      tableName,
      schema,
      columns,
      operations,
      enumName,
      values,
      ifNotExists
    } = validationResult.data;

    try {
      switch (operation) {
        case 'get_info': {
          const result = await executeGetSchemaInfo({
            connectionString: connStringArg,
            schema: schema || 'public',
            tableName
          }, getConnectionStringVal);
          const resolvedSchema = schema || 'public';
          const message = tableName
            ? `Schema information for table ${resolvedSchema}.${tableName}`
            : `List of tables in schema ${resolvedSchema}`;
          return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'create_table': {
          if (!tableName || !columns || columns.length === 0) {
            return { 
              content: [{ type: 'text', text: 'Error: tableName and columns are required for create_table operation' }], 
              isError: true 
            };
          }
          const result = await executeCreateTable({
            connectionString: connStringArg,
            tableName,
            schema: schema || 'public',
            columns
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Table ${result.tableName} created successfully (if not exists).` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'alter_table': {
          if (!tableName || !operations || operations.length === 0) {
            return { 
              content: [{ type: 'text', text: 'Error: tableName and operations are required for alter_table operation' }], 
              isError: true 
            };
          }
          const result = await executeAlterTable({
            connectionString: connStringArg,
            tableName,
            schema: schema || 'public',
            operations
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Table ${result.tableName} altered successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'get_enums': {
          const result = await executeGetEnumsInSchema(
            connStringArg || '', 
            schema || 'public', 
            enumName, 
            getConnectionStringVal
          );
          return { content: [{ type: 'text', text: `Fetched ${result.length} ENUM(s).` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'create_enum': {
          if (!enumName || !values || values.length === 0) {
            return { 
              content: [{ type: 'text', text: 'Error: enumName and values are required for create_enum operation' }], 
              isError: true 
            };
          }
          const result = await executeCreateEnumInSchema(
            connStringArg || '', 
            enumName, 
            values, 
            schema || 'public', 
            ifNotExists || false, 
            getConnectionStringVal
          );
          return { content: [{ type: 'text', text: `ENUM type ${result.schema ? `${result.schema}.` : ''}${result.enumName} created successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return { 
            content: [{ type: 'text', text: `Error: Unknown operation "${operation}". Supported operations: get_info, create_table, alter_table, get_enums, create_enum` }], 
            isError: true 
          };
      }

    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error executing ${operation} operation: ${errorMessage}` }], isError: true };
    }
  }
};
