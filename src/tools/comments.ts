import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { quoteIdent, quoteLiteral } from '../utils/sql.js';

interface CommentInfo {
  objectType: string;
  objectName: string;
  objectSchema?: string;
  columnName?: string;
  comment: string | null;
}

interface CommentResult {
  success: boolean;
  message: string;
  details: unknown;
}

// Input schema for the consolidated comments management tool
const ManageCommentsInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['get', 'set', 'remove', 'bulk_get']).describe('Operation: get (retrieve comments), set (add/update comment), remove (delete comment), bulk_get (discovery mode)'),
  
  // Target object identification
  objectType: z.enum(['table', 'column', 'index', 'constraint', 'function', 'trigger', 'view', 'sequence', 'schema', 'database']).optional().describe('Type of database object (required for get/set/remove)'),
  objectName: z.string().optional().describe('Name of the object (required for get/set/remove)'),
  schema: z.string().optional().describe('Schema name (defaults to public, required for most object types)'),
  tableName: z.string().optional().describe('Parent table name (required when objectType is "constraint" or "trigger")'),

  // Column-specific parameters
  columnName: z.string().optional().describe('Column name (required when objectType is "column")'),
  functionSignature: z.string().optional().describe('Function argument types for function comments, e.g. "integer, text" or empty for no arguments'),
  
  // Comment content
  comment: z.string().optional().describe('Comment text (required for set operation)'),
  
  // Bulk get parameters
  includeSystemObjects: z.boolean().optional().describe('Include system objects in bulk_get (defaults to false)'),
  filterObjectType: z.enum(['table', 'column', 'index', 'constraint', 'function', 'trigger', 'view', 'sequence', 'schema', 'database']).optional().describe('Filter by object type in bulk_get operation')
}).strict();

type ManageCommentsInput = z.infer<typeof ManageCommentsInputSchema>;

function formatValidationError(error: z.ZodError): string {
  return error.errors.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join(', ');
}

function quoteSchemaObject(schema: string, objectName: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(objectName)}`;
}

function buildFunctionCommentSignature(signature?: string): string {
  if (!signature || signature.trim() === '') {
    return '()';
  }

  const normalizedSignature = signature.trim();
  if (!/^[A-Za-z0-9_.,\s[\]]+$/.test(normalizedSignature)) {
    throw new Error('Invalid function signature. Use a comma-separated list of simple PostgreSQL type names only.');
  }

  return `(${normalizedSignature})`;
}

function buildCommentTarget(input: ManageCommentsInput): string {
  const { objectType, objectName, schema = 'public', columnName, tableName, functionSignature } = input;

  if (!objectType || !objectName) {
    throw new McpError(ErrorCode.InvalidParams, 'objectType and objectName are required');
  }

  switch (objectType) {
    case 'table':
      return `TABLE ${quoteSchemaObject(schema, objectName)}`;
    case 'column':
      if (!columnName) {
        throw new McpError(ErrorCode.InvalidParams, 'columnName is required when objectType is "column"');
      }
      return `COLUMN ${quoteSchemaObject(schema, objectName)}.${quoteIdent(columnName)}`;
    case 'index':
      return `INDEX ${quoteSchemaObject(schema, objectName)}`;
    case 'function':
      return `FUNCTION ${quoteSchemaObject(schema, objectName)}${buildFunctionCommentSignature(functionSignature)}`;
    case 'view':
      return `VIEW ${quoteSchemaObject(schema, objectName)}`;
    case 'sequence':
      return `SEQUENCE ${quoteSchemaObject(schema, objectName)}`;
    case 'schema':
      return `SCHEMA ${quoteIdent(objectName)}`;
    case 'database':
      return `DATABASE ${quoteIdent(objectName)}`;
    case 'constraint':
      if (!tableName) {
        throw new McpError(ErrorCode.InvalidParams, 'tableName is required when objectType is "constraint"');
      }
      return `CONSTRAINT ${quoteIdent(objectName)} ON ${quoteSchemaObject(schema, tableName)}`;
    case 'trigger':
      if (!tableName) {
        throw new McpError(ErrorCode.InvalidParams, 'tableName is required when objectType is "trigger"');
      }
      return `TRIGGER ${quoteIdent(objectName)} ON ${quoteSchemaObject(schema, tableName)}`;
    default:
      throw new McpError(ErrorCode.InvalidParams, `Unsupported object type: ${objectType}`);
  }
}

/**
 * Get comment for a specific database object
 */
async function executeGetComment(
  input: ManageCommentsInput,
  getConnectionString: GetConnectionStringFn
): Promise<CommentInfo | null> {
  const db = DatabaseConnection.getInstance();
  const { objectType, objectName, schema = 'public', columnName } = input;

  if (!objectType || !objectName) {
    throw new McpError(ErrorCode.InvalidParams, 'objectType and objectName are required for get operation');
  }

  if (objectType === 'column' && !columnName) {
    throw new McpError(ErrorCode.InvalidParams, 'columnName is required when objectType is "column"');
  }

  try {
    const resolvedConnectionString = getConnectionString(input.connectionString);
    await db.connect(resolvedConnectionString);

    let query: string;
    let params: (string | undefined)[];

    switch (objectType) {
      case 'table':
        query = `
          SELECT obj_description(c.oid, 'pg_class') AS comment
          FROM pg_class c
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE c.relname = $1 AND n.nspname = $2 AND c.relkind = 'r'
        `;
        params = [objectName, schema];
        break;

      case 'column':
        query = `
          SELECT col_description(c.oid, a.attnum) AS comment
          FROM pg_class c
          JOIN pg_namespace n ON c.relnamespace = n.oid
          JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE c.relname = $1 AND n.nspname = $2 AND a.attname = $3 AND NOT a.attisdropped
        `;
        params = [objectName, schema, columnName];
        break;

      case 'index':
        query = `
          SELECT obj_description(c.oid, 'pg_class') AS comment
          FROM pg_class c
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE c.relname = $1 AND n.nspname = $2 AND c.relkind = 'i'
        `;
        params = [objectName, schema];
        break;

      case 'function':
        query = `
          SELECT obj_description(p.oid, 'pg_proc') AS comment
          FROM pg_proc p
          JOIN pg_namespace n ON p.pronamespace = n.oid
          WHERE p.proname = $1 AND n.nspname = $2
        `;
        params = [objectName, schema];
        break;

      case 'view':
        query = `
          SELECT obj_description(c.oid, 'pg_class') AS comment
          FROM pg_class c
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE c.relname = $1 AND n.nspname = $2 AND c.relkind = 'v'
        `;
        params = [objectName, schema];
        break;

      case 'sequence':
        query = `
          SELECT obj_description(c.oid, 'pg_class') AS comment
          FROM pg_class c
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE c.relname = $1 AND n.nspname = $2 AND c.relkind = 'S'
        `;
        params = [objectName, schema];
        break;

      case 'schema':
        query = `
          SELECT obj_description(n.oid, 'pg_namespace') AS comment
          FROM pg_namespace n
          WHERE n.nspname = $1
        `;
        params = [objectName];
        break;

      case 'database':
        query = `
          SELECT shobj_description(d.oid, 'pg_database') AS comment
          FROM pg_database d
          WHERE d.datname = $1
        `;
        params = [objectName];
        break;

      case 'constraint':
        query = `
          SELECT obj_description(con.oid, 'pg_constraint') AS comment
          FROM pg_constraint con
          JOIN pg_namespace n ON con.connamespace = n.oid
          WHERE con.conname = $1 AND n.nspname = $2
        `;
        params = [objectName, schema];
        break;

      case 'trigger':
        query = `
          SELECT obj_description(t.oid, 'pg_trigger') AS comment
          FROM pg_trigger t
          JOIN pg_class c ON t.tgrelid = c.oid
          JOIN pg_namespace n ON c.relnamespace = n.oid
          WHERE t.tgname = $1 AND n.nspname = $2
        `;
        params = [objectName, schema];
        break;

      default:
        throw new McpError(ErrorCode.InvalidParams, `Unsupported object type: ${objectType}`);
    }

    const result = await db.query(query, params);
    
    if (result.length === 0) {
      return null;
    }

    return {
      objectType,
      objectName,
      objectSchema: objectType !== 'database' && objectType !== 'schema' ? schema : undefined,
      columnName,
      comment: result[0].comment as string | null
    };

  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, `Failed to get comment: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

/**
 * Set comment on a database object
 */
async function executeSetComment(
  input: ManageCommentsInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ objectType: string; objectName: string; schema?: string; columnName?: string; commentSet: true }> {
  const db = DatabaseConnection.getInstance();
  const { objectType, objectName, schema = 'public', columnName, comment } = input;

  if (!objectType || !objectName || comment === undefined) {
    throw new McpError(ErrorCode.InvalidParams, 'objectType, objectName, and comment are required for set operation');
  }

  try {
    const sql = `COMMENT ON ${buildCommentTarget(input)} IS ${quoteLiteral(comment)}`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(sql);

    return {
      objectType,
      objectName,
      schema: objectType !== 'database' && objectType !== 'schema' ? schema : undefined,
      columnName,
      commentSet: true
    };

  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, `Failed to set comment: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

/**
 * Remove comment from a database object
 */
async function executeRemoveComment(
  input: ManageCommentsInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ objectType: string; objectName: string; schema?: string; columnName?: string }> {
  const db = DatabaseConnection.getInstance();
  const { objectType, objectName, schema = 'public', columnName } = input;

  if (!objectType || !objectName) {
    throw new McpError(ErrorCode.InvalidParams, 'objectType and objectName are required for remove operation');
  }

  try {
    const sql = `COMMENT ON ${buildCommentTarget(input)} IS NULL`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(sql);

    return {
      objectType,
      objectName,
      schema: objectType !== 'database' && objectType !== 'schema' ? schema : undefined,
      columnName
    };

  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }
    throw new McpError(ErrorCode.InternalError, `Failed to remove comment: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

/**
 * Get all comments in a schema/database (bulk discovery)
 */
async function executeBulkGetComments(
  input: ManageCommentsInput,
  getConnectionString: GetConnectionStringFn
): Promise<CommentInfo[]> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { schema = 'public', includeSystemObjects = false, filterObjectType } = input;

  try {
    await db.connect(resolvedConnectionString);
    
    const comments: CommentInfo[] = [];

    // Get table comments
    if (!filterObjectType || filterObjectType === 'table') {
      const tableQuery = `
        SELECT 
          'table' as object_type,
          c.relname as object_name,
          n.nspname as object_schema,
          obj_description(c.oid, 'pg_class') as comment
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relkind = 'r' 
          AND n.nspname = $1
          ${includeSystemObjects ? '' : 'AND n.nspname NOT IN (\'information_schema\', \'pg_catalog\', \'pg_toast\')'}
          AND obj_description(c.oid, 'pg_class') IS NOT NULL
        ORDER BY c.relname
      `;
      const tableResults = await db.query(tableQuery, [schema]);
      comments.push(...tableResults.map(row => ({
        objectType: row.object_type as string,
        objectName: row.object_name as string,
        objectSchema: row.object_schema as string,
        comment: row.comment as string | null
      })));
    }

    // Get column comments
    if (!filterObjectType || filterObjectType === 'column') {
      const columnQuery = `
        SELECT 
          'column' as object_type,
          c.relname as object_name,
          n.nspname as object_schema,
          a.attname as column_name,
          col_description(c.oid, a.attnum) as comment
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE c.relkind = 'r' 
          AND n.nspname = $1
          AND NOT a.attisdropped
          AND a.attnum > 0
          ${includeSystemObjects ? '' : 'AND n.nspname NOT IN (\'information_schema\', \'pg_catalog\', \'pg_toast\')'}
          AND col_description(c.oid, a.attnum) IS NOT NULL
        ORDER BY c.relname, a.attnum
      `;
      const columnResults = await db.query(columnQuery, [schema]);
      comments.push(...columnResults.map(row => ({
        objectType: row.object_type as string,
        objectName: row.object_name as string,
        objectSchema: row.object_schema as string,
        columnName: row.column_name as string,
        comment: row.comment as string | null
      })));
    }

    // Get function comments
    if (!filterObjectType || filterObjectType === 'function') {
      const functionQuery = `
        SELECT 
          'function' as object_type,
          p.proname as object_name,
          n.nspname as object_schema,
          obj_description(p.oid, 'pg_proc') as comment
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = $1
          ${includeSystemObjects ? '' : 'AND n.nspname NOT IN (\'information_schema\', \'pg_catalog\', \'pg_toast\')'}
          AND obj_description(p.oid, 'pg_proc') IS NOT NULL
        ORDER BY p.proname
      `;
      const functionResults = await db.query(functionQuery, [schema]);
      comments.push(...functionResults.map(row => ({
        objectType: row.object_type as string,
        objectName: row.object_name as string,
        objectSchema: row.object_schema as string,
        comment: row.comment as string | null
      })));
    }

    // Get index comments
    if (!filterObjectType || filterObjectType === 'index') {
      const indexQuery = `
        SELECT 
          'index' as object_type,
          c.relname as object_name,
          n.nspname as object_schema,
          obj_description(c.oid, 'pg_class') as comment
        FROM pg_class c
        JOIN pg_namespace n ON c.relnamespace = n.oid
        WHERE c.relkind = 'i' 
          AND n.nspname = $1
          ${includeSystemObjects ? '' : 'AND n.nspname NOT IN (\'information_schema\', \'pg_catalog\', \'pg_toast\')'}
          AND obj_description(c.oid, 'pg_class') IS NOT NULL
        ORDER BY c.relname
      `;
      const indexResults = await db.query(indexQuery, [schema]);
      comments.push(...indexResults.map(row => ({
        objectType: row.object_type as string,
        objectName: row.object_name as string,
        objectSchema: row.object_schema as string,
        comment: row.comment as string | null
      })));
    }

    return comments;

  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to get bulk comments: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

// Consolidated Comments Management Tool
export const manageCommentsTool: PostgresTool = {
  name: 'pg_manage_comments',
  description: 'Manage PostgreSQL object comments - get, set, remove comments on tables, columns, functions, and other database objects. Examples: operation="get" with objectType="table", objectName="users", operation="set" with comment text, operation="bulk_get" for discovery',
  inputSchema: ManageCommentsInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ManageCommentsInputSchema.safeParse(args);
    if (!validationResult.success) {
      return {
        content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }],
        isError: true
      };
    }

    const input = validationResult.data;

    try {
      switch (input.operation) {
        case 'get': {
          const result = await executeGetComment(input, getConnectionStringVal);
          if (!result) {
            return { 
              content: [{ type: 'text', text: `No comment found for ${input.objectType} ${input.objectName}` }] 
            };
          }
          return { 
            content: [
              { type: 'text', text: `Comment for ${input.objectType} ${input.objectName}${input.columnName ? `.${input.columnName}` : ''}` },
              { type: 'text', text: JSON.stringify(result, null, 2) }
            ] 
          };
        }

        case 'set': {
          const result = await executeSetComment(input, getConnectionStringVal);
          return { 
            content: [
              { type: 'text', text: `Comment set successfully on ${result.objectType} ${result.objectName}${result.columnName ? `.${result.columnName}` : ''}` },
              { type: 'text', text: JSON.stringify(result, null, 2) }
            ] 
          };
        }

        case 'remove': {
          const result = await executeRemoveComment(input, getConnectionStringVal);
          return { 
            content: [
              { type: 'text', text: `Comment removed from ${result.objectType} ${result.objectName}${result.columnName ? `.${result.columnName}` : ''}` },
              { type: 'text', text: JSON.stringify(result, null, 2) }
            ] 
          };
        }

        case 'bulk_get': {
          const result = await executeBulkGetComments(input, getConnectionStringVal);
          return { 
            content: [
              { type: 'text', text: `Found ${result.length} comments in schema ${input.schema || 'public'}` },
              { type: 'text', text: JSON.stringify(result, null, 2) }
            ] 
          };
        }

        default:
          return { 
            content: [{ type: 'text', text: `Error: Unknown operation "${input.operation}". Supported operations: get, set, remove, bulk_get` }], 
            isError: true 
          };
      }

    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { 
        content: [{ type: 'text', text: `Error executing ${input.operation} operation: ${errorMessage}` }], 
        isError: true 
      };
    }
  }
};
