import { DatabaseConnection } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';

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
  
  // Column-specific parameters
  columnName: z.string().optional().describe('Column name (required when objectType is "column")'),
  
  // Comment content
  comment: z.string().optional().describe('Comment text (required for set operation)'),
  
  // Bulk get parameters
  includeSystemObjects: z.boolean().optional().describe('Include system objects in bulk_get (defaults to false)'),
  filterObjectType: z.enum(['table', 'column', 'index', 'constraint', 'function', 'trigger', 'view', 'sequence', 'schema', 'database']).optional().describe('Filter by object type in bulk_get operation')
});

type ManageCommentsInput = z.infer<typeof ManageCommentsInputSchema>;

/**
 * Get comment for a specific database object
 */
async function executeGetComment(
  input: ManageCommentsInput,
  getConnectionString: GetConnectionStringFn
): Promise<CommentInfo | null> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { objectType, objectName, schema = 'public', columnName } = input;

  if (!objectType || !objectName) {
    throw new McpError(ErrorCode.InvalidParams, 'objectType and objectName are required for get operation');
  }

  try {
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
        if (!columnName) {
          throw new McpError(ErrorCode.InvalidParams, 'columnName is required when objectType is "column"');
        }
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
    throw new McpError(ErrorCode.InternalError, `Failed to get comment: ${error instanceof Error ? error.message : String(error)}`);
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
): Promise<{ objectType: string; objectName: string; schema?: string; columnName?: string; comment: string }> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { objectType, objectName, schema = 'public', columnName, comment } = input;

  if (!objectType || !objectName || comment === undefined) {
    throw new McpError(ErrorCode.InvalidParams, 'objectType, objectName, and comment are required for set operation');
  }

  try {
    await db.connect(resolvedConnectionString);
    
    let sql: string;
    const escapedComment = comment.replace(/'/g, "''"); // Escape single quotes

    switch (objectType) {
      case 'table':
        sql = `COMMENT ON TABLE "${schema}"."${objectName}" IS '${escapedComment}'`;
        break;

      case 'column':
        if (!columnName) {
          throw new McpError(ErrorCode.InvalidParams, 'columnName is required when objectType is "column"');
        }
        sql = `COMMENT ON COLUMN "${schema}"."${objectName}"."${columnName}" IS '${escapedComment}'`;
        break;

      case 'index':
        sql = `COMMENT ON INDEX "${schema}"."${objectName}" IS '${escapedComment}'`;
        break;

      case 'function':
        // Note: This is simplified - in practice, you'd need to handle function overloads
        sql = `COMMENT ON FUNCTION "${schema}"."${objectName}" IS '${escapedComment}'`;
        break;

      case 'view':
        sql = `COMMENT ON VIEW "${schema}"."${objectName}" IS '${escapedComment}'`;
        break;

      case 'sequence':
        sql = `COMMENT ON SEQUENCE "${schema}"."${objectName}" IS '${escapedComment}'`;
        break;

      case 'schema':
        sql = `COMMENT ON SCHEMA "${objectName}" IS '${escapedComment}'`;
        break;

      case 'database':
        sql = `COMMENT ON DATABASE "${objectName}" IS '${escapedComment}'`;
        break;

      case 'constraint':
        sql = `COMMENT ON CONSTRAINT "${objectName}" ON "${schema}"."${objectName}" IS '${escapedComment}'`;
        break;

      case 'trigger':
        // Note: PostgreSQL doesn't support COMMENT ON TRIGGER directly
        throw new McpError(ErrorCode.InvalidParams, 'PostgreSQL does not support comments on triggers');

      default:
        throw new McpError(ErrorCode.InvalidParams, `Unsupported object type: ${objectType}`);
    }

    await db.query(sql);

    return {
      objectType,
      objectName,
      schema: objectType !== 'database' && objectType !== 'schema' ? schema : undefined,
      columnName,
      comment
    };

  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to set comment: ${error instanceof Error ? error.message : String(error)}`);
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
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { objectType, objectName, schema = 'public', columnName } = input;

  if (!objectType || !objectName) {
    throw new McpError(ErrorCode.InvalidParams, 'objectType and objectName are required for remove operation');
  }

  try {
    await db.connect(resolvedConnectionString);
    
    let sql: string;

    switch (objectType) {
      case 'table':
        sql = `COMMENT ON TABLE "${schema}"."${objectName}" IS NULL`;
        break;

      case 'column':
        if (!columnName) {
          throw new McpError(ErrorCode.InvalidParams, 'columnName is required when objectType is "column"');
        }
        sql = `COMMENT ON COLUMN "${schema}"."${objectName}"."${columnName}" IS NULL`;
        break;

      case 'index':
        sql = `COMMENT ON INDEX "${schema}"."${objectName}" IS NULL`;
        break;

      case 'function':
        sql = `COMMENT ON FUNCTION "${schema}"."${objectName}" IS NULL`;
        break;

      case 'view':
        sql = `COMMENT ON VIEW "${schema}"."${objectName}" IS NULL`;
        break;

      case 'sequence':
        sql = `COMMENT ON SEQUENCE "${schema}"."${objectName}" IS NULL`;
        break;

      case 'schema':
        sql = `COMMENT ON SCHEMA "${objectName}" IS NULL`;
        break;

      case 'database':
        sql = `COMMENT ON DATABASE "${objectName}" IS NULL`;
        break;

      case 'constraint':
        sql = `COMMENT ON CONSTRAINT "${objectName}" ON "${schema}"."${objectName}" IS NULL`;
        break;

      case 'trigger':
        throw new McpError(ErrorCode.InvalidParams, 'PostgreSQL does not support comments on triggers');

      default:
        throw new McpError(ErrorCode.InvalidParams, `Unsupported object type: ${objectType}`);
    }

    await db.query(sql);

    return {
      objectType,
      objectName,
      schema: objectType !== 'database' && objectType !== 'schema' ? schema : undefined,
      columnName
    };

  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to remove comment: ${error instanceof Error ? error.message : String(error)}`);
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
    throw new McpError(ErrorCode.InternalError, `Failed to get bulk comments: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await db.disconnect();
  }
}

// Consolidated Comments Management Tool
export const manageCommentsTool: PostgresTool = {
  name: 'pg_manage_comments',
  description: 'Manage PostgreSQL object comments - get, set, remove comments on tables, columns, functions, and other database objects. Examples: operation="get" with objectType="table", objectName="users", operation="set" with comment text, operation="bulk_get" for discovery. Use when the user wants to pg manage comments. Unlike pg_manage_constraints, pg_manage_functions, this tool specifically handles pg manage comments.',
  inputSchema: ManageCommentsInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ManageCommentsInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { 
        content: [{ type: 'text', text: `Invalid input: ${validationResult.error.format()}` }], 
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
      const errorMessage = error instanceof McpError ? error.message : (error instanceof Error ? error.message : String(error));
      return { 
        content: [{ type: 'text', text: `Error executing ${input.operation} operation: ${errorMessage}` }], 
        isError: true 
      };
    }
  }
}; 