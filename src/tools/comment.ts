import { DatabaseConnection } from '../utils/connection.js';

interface CommentResult {
  success: boolean;
  message: string;
  details: unknown;
}

/**
 * Set a comment on a database object
 * 
 * @param connectionString - PostgreSQL connection string
 * @param objectType - Type of database object (table, column, function, policy, etc.)
 * @param objectName - Name of the object to comment on
 * @param comment - The comment text
 * @param options - Additional options like schema name or parent object name
 */
export async function setDatabaseComment(
  connectionString: string,
  objectType: 'table' | 'column' | 'function' | 'policy' | 'trigger' | 'constraint' | 'index' | 'sequence',
  objectName: string,
  comment: string,
  options: {
    schema?: string;
    parentObject?: string; // For columns, constraints, policies, triggers
    parameters?: string;   // For functions
  } = {}
): Promise<CommentResult> {
  const db = DatabaseConnection.getInstance();
  
  try {
    await db.connect(connectionString);
    
    const schema = options.schema || 'public';
    let sql = '';
    
    // Escape single quotes in comment
    const escapedComment = comment.replace(/'/g, "''");
    
    // Build the appropriate COMMENT ON statement based on object type
    switch (objectType) {
      case 'table':
        sql = `COMMENT ON TABLE ${schema}.${objectName} IS '${escapedComment}'`;
        break;
        
      case 'column':
        if (!options.parentObject) {
          throw new Error('Parent object (table name) is required for column comments');
        }
        sql = `COMMENT ON COLUMN ${schema}.${options.parentObject}.${objectName} IS '${escapedComment}'`;
        break;
        
      case 'function':
        const params = options.parameters ? `(${options.parameters})` : '';
        sql = `COMMENT ON FUNCTION ${schema}.${objectName}${params} IS '${escapedComment}'`;
        break;
        
      case 'policy':
        if (!options.parentObject) {
          throw new Error('Parent object (table name) is required for policy comments');
        }
        sql = `COMMENT ON POLICY ${objectName} ON ${schema}.${options.parentObject} IS '${escapedComment}'`;
        break;
        
      case 'trigger':
        if (!options.parentObject) {
          throw new Error('Parent object (table name) is required for trigger comments');
        }
        sql = `COMMENT ON TRIGGER ${objectName} ON ${schema}.${options.parentObject} IS '${escapedComment}'`;
        break;
        
      case 'constraint':
        if (!options.parentObject) {
          throw new Error('Parent object (table name) is required for constraint comments');
        }
        sql = `COMMENT ON CONSTRAINT ${objectName} ON ${schema}.${options.parentObject} IS '${escapedComment}'`;
        break;
        
      case 'index':
        sql = `COMMENT ON INDEX ${schema}.${objectName} IS '${escapedComment}'`;
        break;
        
      case 'sequence':
        sql = `COMMENT ON SEQUENCE ${schema}.${objectName} IS '${escapedComment}'`;
        break;
        
      default:
        throw new Error(`Unsupported object type: ${objectType}`);
    }
    
    await db.query(sql);
    
    return {
      success: true,
      message: `Comment set successfully on ${objectType} ${objectName}`,
      details: {
        objectType,
        objectName,
        schema,
        parentObject: options.parentObject
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to set comment: ${error instanceof Error ? error.message : String(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Remove a comment from a database object
 * 
 * @param connectionString - PostgreSQL connection string
 * @param objectType - Type of database object (table, column, function, policy, etc.)
 * @param objectName - Name of the object to remove comment from
 * @param options - Additional options like schema name or parent object name
 */
export async function removeDatabaseComment(
  connectionString: string,
  objectType: 'table' | 'column' | 'function' | 'policy' | 'trigger' | 'constraint' | 'index' | 'sequence',
  objectName: string,
  options: {
    schema?: string;
    parentObject?: string; // For columns, constraints, policies, triggers
    parameters?: string;   // For functions
  } = {}
): Promise<CommentResult> {
  // Setting a NULL comment effectively removes it
  return setDatabaseComment(connectionString, objectType, objectName, 'NULL', options);
}

/**
 * Get a comment from a database object
 * 
 * @param connectionString - PostgreSQL connection string
 * @param objectType - Type of database object (table, column, function, policy, etc.)
 * @param objectName - Name of the object to get comment from
 * @param options - Additional options like schema name or parent object name
 */
export async function getDatabaseComment(
  connectionString: string,
  objectType: 'table' | 'column' | 'function' | 'policy' | 'trigger' | 'constraint' | 'index' | 'sequence',
  objectName: string,
  options: {
    schema?: string;
    parentObject?: string; // For columns, constraints, policies, triggers
    parameters?: string;   // For functions
  } = {}
): Promise<CommentResult> {
  const db = DatabaseConnection.getInstance();
  
  try {
    await db.connect(connectionString);
    
    const schema = options.schema || 'public';
    let sql = '';
    
    // Build the appropriate query based on object type
    switch (objectType) {
      case 'table':
        sql = `SELECT obj_description(to_regclass('${schema}.${objectName}')::oid) AS comment`;
        break;
        
      case 'column':
        if (!options.parentObject) {
          throw new Error('Parent object (table name) is required for column comments');
        }
        sql = `SELECT col_description(
          (SELECT oid FROM pg_class WHERE relname = '${objectName}' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schema}')),
          (SELECT attnum FROM pg_attribute WHERE attrelid = (SELECT oid FROM pg_class WHERE relname = '${options.parentObject}' AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = '${schema}')) AND attname = '${objectName}')
        ) AS comment`;
        break;
        
      case 'function':
        const params = options.parameters ? `(${options.parameters})` : '';
        sql = `SELECT pg_description.description AS comment
          FROM pg_proc
          JOIN pg_namespace ON pg_proc.pronamespace = pg_namespace.oid
          JOIN pg_description ON pg_description.objoid = pg_proc.oid
          WHERE pg_proc.proname = '${objectName}'
          AND pg_namespace.nspname = '${schema}'`;
        break;
        
      case 'policy':
        if (!options.parentObject) {
          throw new Error('Parent object (table name) is required for policy comments');
        }
        sql = `SELECT pg_description.description AS comment
          FROM pg_policy
          JOIN pg_class ON pg_policy.polrelid = pg_class.oid
          JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid
          JOIN pg_description ON pg_description.objoid = pg_policy.oid
          WHERE pg_policy.polname = '${objectName}'
          AND pg_class.relname = '${options.parentObject}'
          AND pg_namespace.nspname = '${schema}'`;
        break;
        
      case 'trigger':
        if (!options.parentObject) {
          throw new Error('Parent object (table name) is required for trigger comments');
        }
        sql = `SELECT pg_description.description AS comment
          FROM pg_trigger
          JOIN pg_class ON pg_trigger.tgrelid = pg_class.oid
          JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid
          JOIN pg_description ON pg_description.objoid = pg_trigger.oid
          WHERE pg_trigger.tgname = '${objectName}'
          AND pg_class.relname = '${options.parentObject}'
          AND pg_namespace.nspname = '${schema}'`;
        break;
        
      case 'constraint':
        if (!options.parentObject) {
          throw new Error('Parent object (table name) is required for constraint comments');
        }
        sql = `SELECT pg_description.description AS comment
          FROM pg_constraint
          JOIN pg_class ON pg_constraint.conrelid = pg_class.oid
          JOIN pg_namespace ON pg_class.relnamespace = pg_namespace.oid
          JOIN pg_description ON pg_description.objoid = pg_constraint.oid
          WHERE pg_constraint.conname = '${objectName}'
          AND pg_class.relname = '${options.parentObject}'
          AND pg_namespace.nspname = '${schema}'`;
        break;
        
      case 'index':
        sql = `SELECT pg_description.description AS comment
          FROM pg_index
          JOIN pg_class idx ON pg_index.indexrelid = idx.oid
          JOIN pg_namespace ON idx.relnamespace = pg_namespace.oid
          JOIN pg_description ON pg_description.objoid = idx.oid
          WHERE idx.relname = '${objectName}'
          AND pg_namespace.nspname = '${schema}'`;
        break;
        
      case 'sequence':
        sql = `SELECT obj_description(to_regclass('${schema}.${objectName}')::oid) AS comment`;
        break;
        
      default:
        throw new Error(`Unsupported object type: ${objectType}`);
    }
    
    const rows = await db.query(sql);
    const comment = rows.length > 0 ? rows[0].comment : null;
    
    return {
      success: true,
      message: `Comment retrieved successfully for ${objectType} ${objectName}`,
      details: {
        objectType,
        objectName,
        schema,
        parentObject: options.parentObject,
        comment
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get comment: ${error instanceof Error ? error.message : String(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}
