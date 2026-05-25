import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { quoteIdent, quoteQualifiedIdent, redactSqlText } from '../utils/sql.js';

interface ConstraintInfo {
  constraint_name: string;
  constraint_type: string;
  table_name: string;
  column_name: string;
  foreign_table_name?: string;
  foreign_column_name?: string;
  check_clause?: string;
  is_deferrable: string;
  initially_deferred: string;
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

// --- Get Constraints Tool ---
const GetConstraintsInputSchema = z.object({
  connectionString: z.string().optional(),
  schema: z.string().optional().default('public').describe("Schema name"),
  tableName: z.string().optional().describe("Optional table name to filter constraints"),
  constraintType: z.enum(['PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE', 'CHECK']).optional().describe("Filter by constraint type"),
}).strict();
type GetConstraintsInput = z.infer<typeof GetConstraintsInputSchema>;

async function executeGetConstraints(
  input: GetConstraintsInput,
  getConnectionString: GetConnectionStringFn
): Promise<ConstraintInfo[]> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { schema, tableName, constraintType } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    const whereConditions = ["tc.table_schema = $1"];
    const params: string[] = [schema];
    let paramIndex = 2;
    
    if (tableName) {
      whereConditions.push(`tc.table_name = $${paramIndex}`);
      params.push(tableName);
      paramIndex++;
    }
    
    if (constraintType) {
      whereConditions.push(`tc.constraint_type = $${paramIndex}`);
      params.push(constraintType);
      paramIndex++;
    }
    
    const whereClause = whereConditions.join(' AND ');
    
    const constraintsQuery = `
      SELECT 
        tc.constraint_name,
        tc.constraint_type,
        tc.table_name,
        kcu.column_name,
        ccu.table_name as foreign_table_name,
        ccu.column_name as foreign_column_name,
        cc.check_clause,
        tc.is_deferrable,
        tc.initially_deferred
      FROM information_schema.table_constraints tc
      LEFT JOIN information_schema.key_column_usage kcu 
        ON tc.constraint_name = kcu.constraint_name 
        AND tc.table_schema = kcu.table_schema
      LEFT JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
      LEFT JOIN information_schema.check_constraints cc
        ON tc.constraint_name = cc.constraint_name
        AND tc.table_schema = cc.constraint_schema
      WHERE ${whereClause}
      ORDER BY tc.table_name, tc.constraint_type, tc.constraint_name
    `;
    
    const result = await db.query<ConstraintInfo>(constraintsQuery, params);
    return result.map((constraint) => ({
      ...constraint,
      check_clause: constraint.check_clause ? redactSqlText(constraint.check_clause) : constraint.check_clause
    }));
    
  } catch (error) {
    throw toInternalError('Failed to get constraints', error);
  } finally {
    await db.disconnect();
  }
}

export const getConstraintsTool: PostgresTool = {
  name: 'pg_get_constraints',
  description: 'List all constraints (primary keys, foreign keys, unique, check)',
  inputSchema: GetConstraintsInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = GetConstraintsInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeGetConstraints(validationResult.data, getConnectionString);
      const message = validationResult.data.tableName 
        ? `Constraints for table ${validationResult.data.tableName}` 
        : `All constraints in schema ${validationResult.data.schema}`;
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error getting constraints: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Create Foreign Key Tool ---
const CreateForeignKeyInputSchema = z.object({
  connectionString: z.string().optional(),
  constraintName: z.string().describe("Name of the foreign key constraint"),
  tableName: z.string().describe("Table to add the foreign key to"),
  columnNames: z.array(z.string()).min(1).describe("Column names in the table"),
  referencedTable: z.string().describe("Referenced table name"),
  referencedColumns: z.array(z.string()).min(1).describe("Referenced column names"),
  schema: z.string().optional().default('public').describe("Schema name"),
  referencedSchema: z.string().optional().describe("Referenced table schema (defaults to same as table schema)"),
  onUpdate: z.enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']).optional().default('NO ACTION').describe("ON UPDATE action"),
  onDelete: z.enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']).optional().default('NO ACTION').describe("ON DELETE action"),
  deferrable: z.boolean().optional().default(false).describe("Make constraint deferrable"),
  initiallyDeferred: z.boolean().optional().default(false).describe("Initially deferred"),
}).strict();
type CreateForeignKeyInput = z.infer<typeof CreateForeignKeyInputSchema>;

async function executeCreateForeignKey(
  input: CreateForeignKeyInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ constraintName: string; tableName: string; created: true }> {
  const db = DatabaseConnection.getInstance();
  const {
    constraintName,
    tableName,
    columnNames,
    referencedTable,
    referencedColumns,
    schema,
    referencedSchema,
    onUpdate,
    onDelete,
    deferrable,
    initiallyDeferred
  } = input;

  try {
    if (columnNames.length !== referencedColumns.length) {
      throw new McpError(ErrorCode.InvalidParams, 'Number of columns must match number of referenced columns');
    }

    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const qualifiedReferencedTable = quoteQualifiedIdent(referencedTable, referencedSchema || schema);
    const columnsClause = columnNames.map(quoteIdent).join(', ');
    const referencedColumnsClause = referencedColumns.map(quoteIdent).join(', ');

    const deferrableClause = deferrable ? ' DEFERRABLE' : '';
    const initiallyDeferredClause = initiallyDeferred ? ' INITIALLY DEFERRED' : '';

    const createFkSQL = `
      ALTER TABLE ${qualifiedTableName}
      ADD CONSTRAINT ${quoteIdent(constraintName)}
      FOREIGN KEY (${columnsClause})
      REFERENCES ${qualifiedReferencedTable} (${referencedColumnsClause})
      ON UPDATE ${onUpdate}
      ON DELETE ${onDelete}${deferrableClause}${initiallyDeferredClause}
    `;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(createFkSQL);

    return { constraintName, tableName, created: true };
  } catch (error) {
    throw toInternalError('Failed to create foreign key', error);
  } finally {
    await db.disconnect();
  }
}

export const createForeignKeyTool: PostgresTool = {
  name: 'pg_create_foreign_key',
  description: 'Create a foreign key constraint',
  inputSchema: CreateForeignKeyInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = CreateForeignKeyInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeCreateForeignKey(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Foreign key ${result.constraintName} created successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error creating foreign key: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Drop Foreign Key Tool ---
const DropForeignKeyInputSchema = z.object({
  connectionString: z.string().optional(),
  constraintName: z.string().describe("Name of the foreign key constraint to drop"),
  tableName: z.string().describe("Table name"),
  schema: z.string().optional().default('public').describe("Schema name"),
  ifExists: z.boolean().optional().default(true).describe("Include IF EXISTS clause"),
  cascade: z.boolean().optional().default(false).describe("Include CASCADE clause"),
}).strict();
type DropForeignKeyInput = z.infer<typeof DropForeignKeyInputSchema>;

async function executeDropForeignKey(
  input: DropForeignKeyInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ constraintName: string; tableName: string; dropped: true }> {
  const db = DatabaseConnection.getInstance();
  const { constraintName, tableName, schema, ifExists, cascade } = input;

  try {
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const ifExistsClause = ifExists ? 'IF EXISTS ' : '';
    const cascadeClause = cascade ? ' CASCADE' : '';

    const dropFkSQL = `ALTER TABLE ${qualifiedTableName} DROP CONSTRAINT ${ifExistsClause}${quoteIdent(constraintName)}${cascadeClause}`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(dropFkSQL);

    return { constraintName, tableName, dropped: true };
  } catch (error) {
    throw toInternalError('Failed to drop foreign key', error);
  } finally {
    await db.disconnect();
  }
}

export const dropForeignKeyTool: PostgresTool = {
  name: 'pg_drop_foreign_key',
  description: 'Drop a foreign key constraint',
  inputSchema: DropForeignKeyInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = DropForeignKeyInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeDropForeignKey(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Foreign key ${result.constraintName} dropped successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error dropping foreign key: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Create Constraint Tool ---
const CreateConstraintInputSchema = z.object({
  connectionString: z.string().optional(),
  constraintName: z.string().describe("Name of the constraint"),
  tableName: z.string().describe("Table to add the constraint to"),
  constraintType: z.enum(['unique', 'check', 'primary_key']).describe("Type of constraint"),
  columnNames: z.array(z.string()).min(1).optional().describe("Column names (for unique/primary key constraints)"),
  checkExpression: z.string().optional().describe("Check expression (for check constraints)"),
  schema: z.string().optional().default('public').describe("Schema name"),
  deferrable: z.boolean().optional().default(false).describe("Make constraint deferrable"),
  initiallyDeferred: z.boolean().optional().default(false).describe("Initially deferred"),
}).strict();
type CreateConstraintInput = z.infer<typeof CreateConstraintInputSchema>;

async function executeCreateConstraint(
  input: CreateConstraintInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ constraintName: string; tableName: string; constraintType: string; created: true }> {
  const db = DatabaseConnection.getInstance();
  const {
    constraintName,
    tableName,
    constraintType,
    columnNames,
    checkExpression,
    schema,
    deferrable,
    initiallyDeferred
  } = input;

  try {
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const deferrableClause = deferrable ? ' DEFERRABLE' : '';
    const initiallyDeferredClause = initiallyDeferred ? ' INITIALLY DEFERRED' : '';

    let constraintClause = '';

    switch (constraintType) {
      case 'unique':
        if (!columnNames || columnNames.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'Column names are required for unique constraints');
        }
        constraintClause = `UNIQUE (${columnNames.map(quoteIdent).join(', ')})`;
        break;
      case 'primary_key':
        if (!columnNames || columnNames.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, 'Column names are required for primary key constraints');
        }
        constraintClause = `PRIMARY KEY (${columnNames.map(quoteIdent).join(', ')})`;
        break;
      case 'check':
        if (!checkExpression) {
          throw new McpError(ErrorCode.InvalidParams, 'Check expression is required for check constraints');
        }
        constraintClause = `CHECK (${checkExpression})`;
        break;
    }

    const createConstraintSQL = `
      ALTER TABLE ${qualifiedTableName}
      ADD CONSTRAINT ${quoteIdent(constraintName)}
      ${constraintClause}${deferrableClause}${initiallyDeferredClause}
    `;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(createConstraintSQL);

    return { constraintName, tableName, constraintType, created: true };
  } catch (error) {
    throw toInternalError('Failed to create constraint', error);
  } finally {
    await db.disconnect();
  }
}

export const createConstraintTool: PostgresTool = {
  name: 'pg_create_constraint',
  description: 'Create a constraint (unique, check, or primary key)',
  inputSchema: CreateConstraintInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = CreateConstraintInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeCreateConstraint(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `${result.constraintType} constraint ${result.constraintName} created successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error creating constraint: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Drop Constraint Tool ---
const DropConstraintInputSchema = z.object({
  connectionString: z.string().optional(),
  constraintName: z.string().describe("Name of the constraint to drop"),
  tableName: z.string().describe("Table name"),
  schema: z.string().optional().default('public').describe("Schema name"),
  ifExists: z.boolean().optional().default(true).describe("Include IF EXISTS clause"),
  cascade: z.boolean().optional().default(false).describe("Include CASCADE clause"),
}).strict();
type DropConstraintInput = z.infer<typeof DropConstraintInputSchema>;

async function executeDropConstraint(
  input: DropConstraintInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ constraintName: string; tableName: string; dropped: true }> {
  const db = DatabaseConnection.getInstance();
  const { constraintName, tableName, schema, ifExists, cascade } = input;

  try {
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const ifExistsClause = ifExists ? 'IF EXISTS ' : '';
    const cascadeClause = cascade ? ' CASCADE' : '';

    const dropConstraintSQL = `ALTER TABLE ${qualifiedTableName} DROP CONSTRAINT ${ifExistsClause}${quoteIdent(constraintName)}${cascadeClause}`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(dropConstraintSQL);

    return { constraintName, tableName, dropped: true };
  } catch (error) {
    throw toInternalError('Failed to drop constraint', error);
  } finally {
    await db.disconnect();
  }
}

export const dropConstraintTool: PostgresTool = {
  name: 'pg_drop_constraint',
  description: 'Drop a constraint',
  inputSchema: DropConstraintInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = DropConstraintInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeDropConstraint(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Constraint ${result.constraintName} dropped successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error dropping constraint: ${errorMessage}` }], isError: true };
    }
  }
};

const ManageConstraintsInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['get', 'create_fk', 'drop_fk', 'create', 'drop']).describe('Operation: get (list constraints), create_fk (foreign key), drop_fk (drop foreign key), create (constraint), drop (constraint)'),

  // Common parameters
  schema: z.string().optional().describe('Schema name (defaults to public)'),
  constraintName: z.string().optional().describe('Constraint name (required for create_fk/drop_fk/create/drop)'),
  tableName: z.string().optional().describe('Table name (optional filter for get, required for create_fk/drop_fk/create/drop)'),

  // Get operation parameters
  constraintType: z.enum(['PRIMARY KEY', 'FOREIGN KEY', 'UNIQUE', 'CHECK']).optional().describe('Filter by constraint type (for get operation)'),

  // Foreign key specific parameters
  columnNames: z.array(z.string()).min(1).optional().describe('Column names in the table (required for create_fk)'),
  referencedTable: z.string().optional().describe('Referenced table name (required for create_fk)'),
  referencedColumns: z.array(z.string()).min(1).optional().describe('Referenced column names (required for create_fk)'),
  referencedSchema: z.string().optional().describe('Referenced table schema (for create_fk, defaults to same as table schema)'),
  onUpdate: z.enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']).optional().describe('ON UPDATE action (for create_fk)'),
  onDelete: z.enum(['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT']).optional().describe('ON DELETE action (for create_fk)'),

  // Constraint specific parameters
  constraintTypeCreate: z.enum(['unique', 'check', 'primary_key']).optional().describe('Type of constraint to create (for create operation)'),
  checkExpression: z.string().optional().describe('Check expression (for create operation with check constraints)'),

  // Common options
  deferrable: z.boolean().optional().describe('Make constraint deferrable (for create_fk/create operations)'),
  initiallyDeferred: z.boolean().optional().describe('Initially deferred (for create_fk/create operations)'),
  ifExists: z.boolean().optional().describe('Include IF EXISTS clause (for drop_fk/drop operations)'),
  cascade: z.boolean().optional().describe('Include CASCADE clause (for drop_fk/drop operations)')
}).strict();

// Consolidated Constraint Management Tool
export const manageConstraintsTool: PostgresTool = {
  name: 'pg_manage_constraints',
  description: 'Manage PostgreSQL constraints - get, create foreign keys, drop foreign keys, create constraints, drop constraints. Examples: operation="get" to list constraints, operation="create_fk" with constraintName, tableName, columnNames, referencedTable, referencedColumns',
  inputSchema: ManageConstraintsInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ManageConstraintsInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const {
      connectionString: connStringArg,
      operation,
      schema,
      constraintName,
      tableName,
      constraintType,
      columnNames,
      referencedTable,
      referencedColumns,
      referencedSchema,
      onUpdate,
      onDelete,
      constraintTypeCreate,
      checkExpression,
      deferrable,
      initiallyDeferred,
      ifExists,
      cascade
    } = validationResult.data;

    try {
      switch (operation) {
        case 'get': {
          const result = await executeGetConstraints({
            connectionString: connStringArg,
            schema: schema || 'public',
            tableName,
            constraintType
          }, getConnectionStringVal);
          const message = tableName 
            ? `Constraints for table ${tableName}` 
            : `All constraints in schema ${schema || 'public'}`;
          return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'create_fk': {
          if (!constraintName || !tableName || !columnNames || !referencedTable || !referencedColumns) {
            return { 
              content: [{ type: 'text', text: 'Error: constraintName, tableName, columnNames, referencedTable, and referencedColumns are required for create_fk operation' }], 
              isError: true 
            };
          }
          const result = await executeCreateForeignKey({
            connectionString: connStringArg,
            constraintName,
            tableName,
            columnNames,
            referencedTable,
            referencedColumns,
            schema: schema || 'public',
            referencedSchema,
            onUpdate: onUpdate || 'NO ACTION',
            onDelete: onDelete || 'NO ACTION',
            deferrable: deferrable || false,
            initiallyDeferred: initiallyDeferred || false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Foreign key ${result.constraintName} created successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'drop_fk': {
          if (!constraintName || !tableName) {
            return { 
              content: [{ type: 'text', text: 'Error: constraintName and tableName are required for drop_fk operation' }], 
              isError: true 
            };
          }
          const result = await executeDropForeignKey({
            connectionString: connStringArg,
            constraintName,
            tableName,
            schema: schema || 'public',
            ifExists: ifExists !== undefined ? ifExists : true,
            cascade: cascade || false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Foreign key ${result.constraintName} dropped successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'create': {
          if (!constraintName || !tableName || !constraintTypeCreate) {
            return { 
              content: [{ type: 'text', text: 'Error: constraintName, tableName, and constraintTypeCreate are required for create operation' }], 
              isError: true 
            };
          }
          const result = await executeCreateConstraint({
            connectionString: connStringArg,
            constraintName,
            tableName,
            constraintType: constraintTypeCreate,
            columnNames,
            checkExpression,
            schema: schema || 'public',
            deferrable: deferrable || false,
            initiallyDeferred: initiallyDeferred || false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `${result.constraintType} constraint ${result.constraintName} created successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'drop': {
          if (!constraintName || !tableName) {
            return { 
              content: [{ type: 'text', text: 'Error: constraintName and tableName are required for drop operation' }], 
              isError: true 
            };
          }
          const result = await executeDropConstraint({
            connectionString: connStringArg,
            constraintName,
            tableName,
            schema: schema || 'public',
            ifExists: ifExists !== undefined ? ifExists : true,
            cascade: cascade || false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Constraint ${result.constraintName} dropped successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return { 
            content: [{ type: 'text', text: `Error: Unknown operation "${operation}". Supported operations: get, create_fk, drop_fk, create, drop` }], 
            isError: true 
          };
      }

    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error executing ${operation} operation: ${errorMessage}` }], isError: true };
    }
  }
};
