import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import { z } from 'zod';
import type { PostgresTool, GetConnectionStringFn, ToolOutput } from '../types/tool.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { quoteIdent, quoteLiteral, quoteQualifiedIdent } from '../utils/sql.js';

interface UserInfo {
  rolname: string;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolcanlogin: boolean;
  rolreplication: boolean;
  rolconnlimit: number;
  rolvaliduntil: string | null;
  oid: number;
}

interface Permission {
  grantee: string;
  table_catalog: string;
  table_schema: string;
  table_name: string;
  privilege_type: string;
  is_grantable: string;
  grantor: string;
}

const PermissionSchema = z.enum(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'ALL']);
const TargetTypeSchema = z.enum(['table', 'schema', 'database', 'sequence', 'function']);
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day;
}

const ConnectionLimitSchema = z.number().int().min(-1).describe('Maximum number of connections (-1 for unlimited)');
const ValidUntilSchema = z.string()
  .refine(isValidIsoDate, 'validUntil must be a valid YYYY-MM-DD calendar date')
  .describe('Password expiration date (YYYY-MM-DD)');

function formatValidationError(error: z.ZodError): string {
  return error.errors.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join(', ');
}

// --- Create User Tool ---
const CreateUserInputSchema = z.object({
  connectionString: z.string().optional(),
  username: z.string().describe("Username for the new user"),
  password: z.string().optional().describe("Password for the user"),
  superuser: z.boolean().optional().default(false).describe("Grant superuser privileges"),
  createdb: z.boolean().optional().default(false).describe("Allow user to create databases"),
  createrole: z.boolean().optional().default(false).describe("Allow user to create roles"),
  login: z.boolean().optional().default(true).describe("Allow user to login"),
  replication: z.boolean().optional().default(false).describe("Allow replication privileges"),
  connectionLimit: ConnectionLimitSchema.optional(),
  validUntil: ValidUntilSchema.optional(),
  inherit: z.boolean().optional().default(true).describe("Inherit privileges from parent roles"),
}).strict();
type CreateUserInput = z.infer<typeof CreateUserInputSchema>;

async function executeCreateUser(
  input: CreateUserInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ username: string; created: true }> {
  const db = DatabaseConnection.getInstance();
  const {
    username,
    password,
    superuser,
    createdb,
    createrole,
    login,
    replication,
    connectionLimit,
    validUntil,
    inherit
  } = input;

  try {
    const quotedUsername = quoteIdent(username);
    const options = [];

    if (password) options.push(`PASSWORD ${quoteLiteral(password)}`);
    if (superuser) options.push('SUPERUSER');
    if (createdb) options.push('CREATEDB');
    if (createrole) options.push('CREATEROLE');
    if (login) options.push('LOGIN');
    if (replication) options.push('REPLICATION');
    if (!inherit) options.push('NOINHERIT');
    if (connectionLimit !== undefined) options.push(`CONNECTION LIMIT ${connectionLimit}`);
    if (validUntil) options.push(`VALID UNTIL ${quoteLiteral(validUntil)}`);

    const createUserSQL = `CREATE USER ${quotedUsername}${options.length > 0 ? ` ${options.join(' ')}` : ''}`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(createUserSQL);
    
    return { username, created: true };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to create user: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const createUserTool: PostgresTool = {
  name: 'pg_create_user',
  description: 'Create a new PostgreSQL user/role',
  inputSchema: CreateUserInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = CreateUserInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeCreateUser(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `User ${result.username} created successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error creating user: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Drop User Tool ---
const DropUserInputSchema = z.object({
  connectionString: z.string().optional(),
  username: z.string().describe("Username to drop"),
  ifExists: z.boolean().optional().default(true).describe("Include IF EXISTS clause"),
  cascade: z.boolean().optional().default(false).describe("Include CASCADE to drop owned objects"),
}).strict();
type DropUserInput = z.infer<typeof DropUserInputSchema>;

async function executeDropUser(
  input: DropUserInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ username: string; dropped: true }> {
  const db = DatabaseConnection.getInstance();
  const { username, ifExists, cascade } = input;

  try {
    const quotedUsername = quoteIdent(username);
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);

    // First, reassign or drop owned objects if cascade is true
    if (cascade) {
      await db.query(`DROP OWNED BY ${quotedUsername} CASCADE`);
    }

    const ifExistsClause = ifExists ? 'IF EXISTS ' : '';
    const dropUserSQL = `DROP USER ${ifExistsClause}${quotedUsername}`;

    await db.query(dropUserSQL);

    return { username, dropped: true };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to drop user: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const dropUserTool: PostgresTool = {
  name: 'pg_drop_user',
  description: 'Drop a PostgreSQL user/role',
  inputSchema: DropUserInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = DropUserInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeDropUser(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `User ${result.username} dropped successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error dropping user: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Alter User Tool ---
const AlterUserInputSchema = z.object({
  connectionString: z.string().optional(),
  username: z.string().describe("Username to alter"),
  password: z.string().optional().describe("New password"),
  superuser: z.boolean().optional().describe("Grant/revoke superuser privileges"),
  createdb: z.boolean().optional().describe("Grant/revoke database creation privileges"),
  createrole: z.boolean().optional().describe("Grant/revoke role creation privileges"),
  login: z.boolean().optional().describe("Grant/revoke login privileges"),
  replication: z.boolean().optional().describe("Grant/revoke replication privileges"),
  connectionLimit: ConnectionLimitSchema.optional().describe("Set connection limit (-1 for unlimited)"),
  validUntil: ValidUntilSchema.optional().describe("Set password expiration date (YYYY-MM-DD)"),
  inherit: z.boolean().optional().describe("Set privilege inheritance"),
}).strict();
type AlterUserInput = z.infer<typeof AlterUserInputSchema>;

async function executeAlterUser(
  input: AlterUserInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ username: string; altered: true; changes: string[] }> {
  const db = DatabaseConnection.getInstance();
  const { 
    username, 
    password, 
    superuser, 
    createdb, 
    createrole, 
    login, 
    replication, 
    connectionLimit, 
    validUntil,
    inherit 
  } = input;

  try {
    const quotedUsername = quoteIdent(username);
    const changes: string[] = [];
    const attributes: string[] = [];
    const addAttribute = (sql: string, change: string) => {
      attributes.push(sql);
      changes.push(change);
    };

    if (password !== undefined) {
      addAttribute(`PASSWORD ${quoteLiteral(password)}`, 'password');
    }

    if (superuser !== undefined) addAttribute(superuser ? 'SUPERUSER' : 'NOSUPERUSER', 'superuser');
    if (createdb !== undefined) addAttribute(createdb ? 'CREATEDB' : 'NOCREATEDB', 'createdb');
    if (createrole !== undefined) addAttribute(createrole ? 'CREATEROLE' : 'NOCREATEROLE', 'createrole');
    if (login !== undefined) addAttribute(login ? 'LOGIN' : 'NOLOGIN', 'login');
    if (replication !== undefined) addAttribute(replication ? 'REPLICATION' : 'NOREPLICATION', 'replication');
    if (inherit !== undefined) addAttribute(inherit ? 'INHERIT' : 'NOINHERIT', 'inherit');
    if (connectionLimit !== undefined) addAttribute(`CONNECTION LIMIT ${connectionLimit}`, 'connectionLimit');
    if (validUntil !== undefined) addAttribute(`VALID UNTIL ${quoteLiteral(validUntil)}`, 'validUntil');

    const resolvedConnectionString = getConnectionString(input.connectionString);
    await db.connect(resolvedConnectionString);

    if (attributes.length > 0) {
      const alterUserSQL = `ALTER USER ${quotedUsername} ${attributes.join(' ')}`;
      await db.query(alterUserSQL);
    }
    
    return { username, altered: true, changes };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to alter user: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const alterUserTool: PostgresTool = {
  name: 'pg_alter_user',
  description: 'Alter an existing PostgreSQL user/role',
  inputSchema: AlterUserInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = AlterUserInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeAlterUser(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `User ${result.username} altered successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error altering user: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Grant Permissions Tool ---
const GrantPermissionsInputSchema = z.object({
  connectionString: z.string().optional(),
  username: z.string().describe("Username to grant permissions to"),
  permissions: z.array(PermissionSchema).min(1).describe("Permissions to grant"),
  target: z.string().describe("Target object (table, schema, database, etc.)"),
  targetType: TargetTypeSchema.describe("Type of target object"),
  schema: z.string().optional().default('public').describe("Schema name (for table/sequence/function targets)"),
  withGrantOption: z.boolean().optional().default(false).describe("Allow user to grant these permissions to others"),
}).strict();
type GrantPermissionsInput = z.infer<typeof GrantPermissionsInputSchema>;

function buildPrivilegeTargetSpec(targetType: 'table' | 'schema' | 'database' | 'sequence' | 'function', target: string, schema = 'public'): string {
  switch (targetType) {
    case 'table':
      return `TABLE ${quoteQualifiedIdent(target, schema)}`;
    case 'schema':
      return `SCHEMA ${quoteIdent(target)}`;
    case 'database':
      return `DATABASE ${quoteIdent(target)}`;
    case 'sequence':
      return `SEQUENCE ${quoteQualifiedIdent(target, schema)}`;
    case 'function':
      return `FUNCTION ${quoteQualifiedIdent(target, schema)}`;
  }
}

async function executeGrantPermissions(
  input: GrantPermissionsInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ username: string; permissions: string[]; target: string; granted: true }> {
  const db = DatabaseConnection.getInstance();
  const { username, permissions, target, targetType, schema, withGrantOption } = input;

  try {
    const targetSpec = buildPrivilegeTargetSpec(targetType, target, schema);
    const permissionsStr = permissions.join(', ');
    const withGrantClause = withGrantOption ? ' WITH GRANT OPTION' : '';

    const grantSQL = `GRANT ${permissionsStr} ON ${targetSpec} TO ${quoteIdent(username)}${withGrantClause}`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(grantSQL);

    return { username, permissions, target, granted: true };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to grant permissions: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const grantPermissionsTool: PostgresTool = {
  name: 'pg_grant_permissions',
  description: 'Grant permissions to a user/role',
  inputSchema: GrantPermissionsInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = GrantPermissionsInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeGrantPermissions(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Permissions granted to ${result.username} successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error granting permissions: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Revoke Permissions Tool ---
const RevokePermissionsInputSchema = z.object({
  connectionString: z.string().optional(),
  username: z.string().describe("Username to revoke permissions from"),
  permissions: z.array(PermissionSchema).min(1).describe("Permissions to revoke"),
  target: z.string().describe("Target object (table, schema, database, etc.)"),
  targetType: TargetTypeSchema.describe("Type of target object"),
  schema: z.string().optional().default('public').describe("Schema name (for table/sequence/function targets)"),
  cascade: z.boolean().optional().default(false).describe("Cascade revoke to dependent privileges"),
}).strict();
type RevokePermissionsInput = z.infer<typeof RevokePermissionsInputSchema>;

async function executeRevokePermissions(
  input: RevokePermissionsInput,
  getConnectionString: GetConnectionStringFn
): Promise<{ username: string; permissions: string[]; target: string; revoked: true }> {
  const db = DatabaseConnection.getInstance();
  const { username, permissions, target, targetType, schema, cascade } = input;

  try {
    const targetSpec = buildPrivilegeTargetSpec(targetType, target, schema);
    const permissionsStr = permissions.join(', ');
    const cascadeClause = cascade ? ' CASCADE' : '';

    const revokeSQL = `REVOKE ${permissionsStr} ON ${targetSpec} FROM ${quoteIdent(username)}${cascadeClause}`;
    const resolvedConnectionString = getConnectionString(input.connectionString);

    await db.connect(resolvedConnectionString);
    await db.query(revokeSQL);

    return { username, permissions, target, revoked: true };
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to revoke permissions: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const revokePermissionsTool: PostgresTool = {
  name: 'pg_revoke_permissions',
  description: 'Revoke permissions from a user/role',
  inputSchema: RevokePermissionsInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = RevokePermissionsInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeRevokePermissions(validationResult.data, getConnectionString);
      return { content: [{ type: 'text', text: `Permissions revoked from ${result.username} successfully.` }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error revoking permissions: ${errorMessage}` }], isError: true };
    }
  }
};

// --- Get User Permissions Tool ---
const GetUserPermissionsInputSchema = z.object({
  connectionString: z.string().optional(),
  username: z.string().optional().describe("Username to get permissions for (optional, shows all if not provided)"),
  schema: z.string().optional().describe("Filter by schema (optional)"),
  targetType: TargetTypeSchema.optional().describe("Filter by target type"),
}).strict();
type GetUserPermissionsInput = z.infer<typeof GetUserPermissionsInputSchema>;

async function executeGetUserPermissions(
  input: GetUserPermissionsInput,
  getConnectionString: GetConnectionStringFn
): Promise<Permission[]> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { username, schema, targetType } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    const whereConditions: string[] = [];
    const params: string[] = [];
    let paramIndex = 1;
    
    if (username) {
      whereConditions.push(`grantee = $${paramIndex}`);
      params.push(username);
      paramIndex++;
    }
    
    if (schema) {
      whereConditions.push(`table_schema = $${paramIndex}`);
      params.push(schema);
      paramIndex++;
    }
    
    // Different views for different object types
    let fromClause = '';
    switch (targetType) {
      case 'table':
        fromClause = 'information_schema.table_privileges';
        break;
      case 'schema':
        fromClause = 'information_schema.usage_privileges';
        break;
      default:
        fromClause = 'information_schema.table_privileges';
    }
    
    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';
    
    const permissionsQuery = `
      SELECT 
        grantee,
        table_catalog,
        table_schema,
        table_name,
        privilege_type,
        is_grantable,
        grantor
      FROM ${fromClause}
      ${whereClause}
      ORDER BY grantee, table_schema, table_name, privilege_type
    `;
    
    const result = await db.query<Permission>(permissionsQuery, params);
    return result;
    
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to get user permissions: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const getUserPermissionsTool: PostgresTool = {
  name: 'pg_get_user_permissions',
  description: 'Get permissions for a user/role or all users',
  inputSchema: GetUserPermissionsInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = GetUserPermissionsInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeGetUserPermissions(validationResult.data, getConnectionString);
      const message = validationResult.data.username 
        ? `Permissions for user ${validationResult.data.username}` 
        : 'All user permissions';
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error getting user permissions: ${errorMessage}` }], isError: true };
    }
  }
};

// --- List Users Tool ---
const ListUsersInputSchema = z.object({
  connectionString: z.string().optional(),
  includeSystemRoles: z.boolean().optional().default(false).describe("Include system roles"),
}).strict();
type ListUsersInput = z.infer<typeof ListUsersInputSchema>;

async function executeListUsers(
  input: ListUsersInput,
  getConnectionString: GetConnectionStringFn
): Promise<UserInfo[]> {
  const resolvedConnectionString = getConnectionString(input.connectionString);
  const db = DatabaseConnection.getInstance();
  const { includeSystemRoles } = input;
  
  try {
    await db.connect(resolvedConnectionString);
    
    const systemRoleFilter = includeSystemRoles ? '' : "WHERE rolname NOT LIKE 'pg_%' AND rolname != 'postgres'";
    
    const usersQuery = `
      SELECT 
        rolname,
        rolsuper,
        rolinherit,
        rolcreaterole,
        rolcreatedb,
        rolcanlogin,
        rolreplication,
        rolconnlimit,
        rolvaliduntil,
        oid
      FROM pg_roles 
      ${systemRoleFilter}
      ORDER BY rolname
    `;
    
    const result = await db.query<UserInfo>(usersQuery);
    return result;
    
  } catch (error) {
    throw new McpError(ErrorCode.InternalError, `Failed to list users: ${sanitizeErrorMessage(error)}`);
  } finally {
    await db.disconnect();
  }
}

export const listUsersTool: PostgresTool = {
  name: 'pg_list_users',
  description: 'List all users/roles in the database',
  inputSchema: ListUsersInputSchema,
  async execute(params: unknown, getConnectionString: GetConnectionStringFn): Promise<ToolOutput> {
    const validationResult = ListUsersInputSchema.safeParse(params);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }
    try {
      const result = await executeListUsers(validationResult.data, getConnectionString);
      const message = validationResult.data.includeSystemRoles 
        ? 'All users and system roles' 
        : 'All user-created roles';
      return { content: [{ type: 'text', text: message }, { type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      return { content: [{ type: 'text', text: `Error listing users: ${errorMessage}` }], isError: true };
    }
  }
};

const ManageUsersInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['create', 'drop', 'alter', 'grant', 'revoke', 'get_permissions', 'list']).describe('Operation: create (new user), drop (remove user), alter (modify user), grant (permissions), revoke (permissions), get_permissions (view permissions), list (all users)'),

  // Common parameters
  username: z.string().optional().describe('Username (required for create/drop/alter/grant/revoke/get_permissions, optional filter for list)'),

  // Create/alter user parameters
  password: z.string().optional().describe('Password for the user (for create operation)'),
  superuser: z.boolean().optional().describe('Grant superuser privileges (for create/alter operations)'),
  createdb: z.boolean().optional().describe('Allow user to create databases (for create/alter operations)'),
  createrole: z.boolean().optional().describe('Allow user to create roles (for create/alter operations)'),
  login: z.boolean().optional().describe('Allow user to login (for create/alter operations)'),
  replication: z.boolean().optional().describe('Allow replication privileges (for create/alter operations)'),
  connectionLimit: ConnectionLimitSchema.optional().describe('Maximum number of connections, -1 for unlimited (for create/alter operations)'),
  validUntil: ValidUntilSchema.optional().describe('Password expiration date YYYY-MM-DD (for create/alter operations)'),
  inherit: z.boolean().optional().describe('Inherit privileges from parent roles (for create/alter operations)'),

  // Drop user parameters
  ifExists: z.boolean().optional().describe('Include IF EXISTS clause (for drop operation)'),
  cascade: z.boolean().optional().describe('Include CASCADE to drop owned objects (for drop/revoke operations)'),

  // Permission parameters
  permissions: z.array(PermissionSchema).min(1).optional().describe('Permissions to grant/revoke: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "ALL"]'),
  target: z.string().optional().describe('Target object name (for grant/revoke operations)'),
  targetType: TargetTypeSchema.optional().describe('Type of target object (for grant/revoke operations)'),
  withGrantOption: z.boolean().optional().describe('Allow user to grant these permissions to others (for grant operation)'),

  // Get permissions parameters
  schema: z.string().optional().describe('Filter by schema (for get_permissions operation)'),

  // List users parameters
  includeSystemRoles: z.boolean().optional().describe('Include system roles (for list operation)')
}).strict();

// Consolidated User Management Tool
export const manageUsersTool: PostgresTool = {
  name: 'pg_manage_users',
  description: 'Manage PostgreSQL users and permissions - create, drop, alter users, grant/revoke permissions. Examples: operation="create" with username="testuser", operation="grant" with username, permissions, target, targetType',
  inputSchema: ManageUsersInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ManageUsersInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const {
      connectionString: connStringArg,
      operation,
      username,
      password,
      superuser,
      createdb,
      createrole,
      login,
      replication,
      connectionLimit,
      validUntil,
      inherit,
      ifExists,
      cascade,
      permissions,
      target,
      targetType,
      withGrantOption,
      schema,
      includeSystemRoles
    } = validationResult.data;

    try {
      switch (operation) {
        case 'create': {
          if (!username) {
            return { 
              content: [{ type: 'text', text: 'Error: username is required for create operation' }], 
              isError: true 
            };
          }
          const result = await executeCreateUser({
            connectionString: connStringArg,
            username,
            password,
            superuser: superuser ?? false,
            createdb: createdb ?? false,
            createrole: createrole ?? false,
            login: login ?? true,
            replication: replication ?? false,
            connectionLimit,
            validUntil,
            inherit: inherit ?? true
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `User ${result.username} created successfully. Details: ${JSON.stringify(result)}` }] };
        }

        case 'drop': {
          if (!username) {
            return { 
              content: [{ type: 'text', text: 'Error: username is required for drop operation' }], 
              isError: true 
            };
          }
          const result = await executeDropUser({
            connectionString: connStringArg,
            username,
            ifExists: ifExists ?? true,
            cascade: cascade ?? false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `User ${result.username} dropped successfully. Details: ${JSON.stringify(result)}` }] };
        }

        case 'alter': {
          if (!username) {
            return { 
              content: [{ type: 'text', text: 'Error: username is required for alter operation' }], 
              isError: true 
            };
          }
          const result = await executeAlterUser({
            connectionString: connStringArg,
            username,
            password,
            superuser,
            createdb,
            createrole,
            login,
            replication,
            connectionLimit,
            validUntil,
            inherit
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `User ${result.username} altered successfully. Changes: ${result.changes.join(', ')}. Details: ${JSON.stringify(result)}` }] };
        }

        case 'grant': {
          if (!username || !permissions || !target || !targetType) {
            return { 
              content: [{ type: 'text', text: 'Error: username, permissions, target, and targetType are required for grant operation' }], 
              isError: true 
            };
          }
          const result = await executeGrantPermissions({
            connectionString: connStringArg,
            username,
            permissions: permissions as ('SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER' | 'ALL')[],
            target,
            targetType,
            withGrantOption: withGrantOption ?? false,
            schema: schema ?? 'public'
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Permissions granted to ${result.username} on ${result.target}. Details: ${JSON.stringify(result)}` }] };
        }

        case 'revoke': {
          if (!username || !permissions || !target || !targetType) {
            return { 
              content: [{ type: 'text', text: 'Error: username, permissions, target, and targetType are required for revoke operation' }], 
              isError: true 
            };
          }
          const result = await executeRevokePermissions({
            connectionString: connStringArg,
            username,
            permissions: permissions as ('SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE' | 'REFERENCES' | 'TRIGGER' | 'ALL')[],
            target,
            targetType,
            cascade: cascade ?? false,
            schema: schema ?? 'public'
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: `Permissions revoked from ${result.username} on ${result.target}. Details: ${JSON.stringify(result)}` }] };
        }

        case 'get_permissions': {
          const result = await executeGetUserPermissions({
            connectionString: connStringArg,
            username,
            schema,
            targetType
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        case 'list': {
          const result = await executeListUsers({
            connectionString: connStringArg,
            includeSystemRoles: includeSystemRoles ?? false
          }, getConnectionStringVal);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        }

        default:
          return { 
            content: [{ type: 'text', text: `Error: Unknown operation "${operation}". Supported operations: create, drop, alter, grant, revoke, get_permissions, list` }], 
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
