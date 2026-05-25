import { DatabaseConnection, sanitizeErrorMessage } from '../utils/connection.js';
import type { PostgresTool, ToolOutput, GetConnectionStringFn } from '../types/tool.js';
import { z } from 'zod';
import { quoteIdent, quoteQualifiedIdent, redactSqlText } from '../utils/sql.js';

interface FunctionResult {
  success: boolean;
  message: string;
  details: unknown;
}

interface FunctionInfo {
  name: string;
  language: string;
  returnType: string;
  arguments: string;
  definition: string;
  volatility: string;
  owner: string;
}

interface RLSPolicyInfo {
  schemaname: string;
  tablename: string;
  policyname: string;
  roles: string[];
  cmd: string;
  using: string | null;
  check: string | null;
}

function redactFunctionInfo(fn: FunctionInfo): FunctionInfo {
  return {
    ...fn,
    definition: redactSqlText(fn.definition)
  };
}

function redactRLSPolicyInfo(policy: RLSPolicyInfo): RLSPolicyInfo {
  return {
    ...policy,
    using: policy.using ? redactSqlText(policy.using) : policy.using,
    check: policy.check ? redactSqlText(policy.check) : policy.check
  };
}

function formatValidationError(error: z.ZodError): string {
  return error.errors.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join(', ');
}

function dollarQuote(value: string): string {
  let tag = 'function';
  let delimiter = `$${tag}$`;
  let counter = 0;

  while (value.includes(delimiter)) {
    counter += 1;
    tag = `function_${counter}`;
    delimiter = `$${tag}$`;
  }

  return `${delimiter}\n${value}\n${delimiter}`;
}

function buildFunctionSignature(parameters?: string): string {
  if (!parameters || parameters.trim() === '') {
    return '()';
  }

  const signature = parameters.trim();
  if (!/^[A-Za-z0-9_.,\s[\]]+$/.test(signature)) {
    throw new Error('Invalid function signature. Use a comma-separated list of simple PostgreSQL type names only.');
  }

  return `(${signature})`;
}

function quoteRoleName(role: string): string {
  return role.toUpperCase() === 'PUBLIC' ? 'PUBLIC' : quoteIdent(role);
}

/**
 * Get information about database functions
 */
async function _getFunctions(
  connectionString: string,
  functionName?: string,
  schema = 'public'
): Promise<FunctionResult> {
  const db = DatabaseConnection.getInstance();
  
  try {
    await db.connect(connectionString);
    
    let query = `
      SELECT 
        p.proname AS name,
        l.lanname AS language,
        pg_get_function_result(p.oid) AS "returnType",
        pg_get_function_arguments(p.oid) AS "arguments",
        CASE
          WHEN p.provolatile = 'i' THEN 'IMMUTABLE'
          WHEN p.provolatile = 's' THEN 'STABLE'
          WHEN p.provolatile = 'v' THEN 'VOLATILE'
        END AS volatility,
        pg_get_functiondef(p.oid) AS definition,
        a.rolname AS owner
      FROM pg_proc p
      JOIN pg_namespace n ON p.pronamespace = n.oid
      JOIN pg_language l ON p.prolang = l.oid
      JOIN pg_authid a ON p.proowner = a.oid
      WHERE n.nspname = $1
    `;
    
    const params: (string | undefined)[] = [schema];
    
    if (functionName) {
      query += ' AND p.proname = $2';
      params.push(functionName);
    }
    
    query += ' ORDER BY p.proname';
    
    const functions = (await db.query<FunctionInfo>(query, params)).map(redactFunctionInfo);
    
    return {
      success: true,
      message: functionName 
        ? `Function information for ${functionName}` 
        : `Found ${functions.length} functions in schema ${schema}`,
      details: functions
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get function information: ${sanitizeErrorMessage(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Create or replace a database function
 */
async function _createFunction(
  connectionString: string,
  functionName: string,
  parameters: string,
  returnType: string,
  functionBody: string,
  options: {
    language?: 'sql' | 'plpgsql' | 'plpython3u';
    volatility?: 'VOLATILE' | 'STABLE' | 'IMMUTABLE';
    schema?: string;
    security?: 'INVOKER' | 'DEFINER';
    replace?: boolean;
  } = {}
): Promise<FunctionResult> {
  const db = DatabaseConnection.getInstance();

  try {
    const language = options.language || 'plpgsql';
    const volatility = options.volatility || 'VOLATILE';
    const schema = options.schema || 'public';
    const security = options.security || 'INVOKER';
    const createOrReplace = options.replace ? 'CREATE OR REPLACE' : 'CREATE';
    const qualifiedFunctionName = quoteQualifiedIdent(functionName, schema);
    const quotedBody = dollarQuote(functionBody);

    // Build function creation SQL
    const sql = `
      ${createOrReplace} FUNCTION ${qualifiedFunctionName}(${parameters})
      RETURNS ${returnType}
      LANGUAGE ${language}
      ${volatility}
      SECURITY ${security}
      AS ${quotedBody};
    `;

    await db.connect(connectionString);
    await db.query(sql);
    
    return {
      success: true,
      message: `Function ${functionName} created successfully`,
      details: {
        name: functionName,
        schema,
        returnType,
        language,
        volatility,
        security
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to create function: ${sanitizeErrorMessage(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Drop a database function
 */
async function _dropFunction(
  connectionString: string,
  functionName: string,
  parameters?: string,
  options: {
    schema?: string;
    ifExists?: boolean;
    cascade?: boolean;
  } = {}
): Promise<FunctionResult> {
  const db = DatabaseConnection.getInstance();

  try {
    const schema = options.schema || 'public';
    const ifExists = options.ifExists ? 'IF EXISTS' : '';
    const cascade = options.cascade ? 'CASCADE' : '';
    const qualifiedFunctionName = quoteQualifiedIdent(functionName, schema);

    // Build function drop SQL
    let sql = `DROP FUNCTION ${ifExists} ${qualifiedFunctionName}${buildFunctionSignature(parameters)}`;

    // Add cascade if specified
    if (cascade) {
      sql += ` ${cascade}`;
    }

    await db.connect(connectionString);
    await db.query(sql);
    
    return {
      success: true,
      message: `Function ${functionName} dropped successfully`,
      details: {
        name: functionName,
        schema
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to drop function: ${sanitizeErrorMessage(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Enable Row-Level Security (RLS) on a table
 */
async function _enableRLS(
  connectionString: string,
  tableName: string,
  schema = 'public'
): Promise<FunctionResult> {
  const db = DatabaseConnection.getInstance();

  try {
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);

    await db.connect(connectionString);
    await db.query(`ALTER TABLE ${qualifiedTableName} ENABLE ROW LEVEL SECURITY`);
    
    return {
      success: true,
      message: `Row-Level Security enabled on ${schema}.${tableName}`,
      details: {
        table: tableName,
        schema
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to enable RLS: ${sanitizeErrorMessage(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Disable Row-Level Security (RLS) on a table
 */
async function _disableRLS(
  connectionString: string,
  tableName: string,
  schema = 'public'
): Promise<FunctionResult> {
  const db = DatabaseConnection.getInstance();

  try {
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);

    await db.connect(connectionString);
    await db.query(`ALTER TABLE ${qualifiedTableName} DISABLE ROW LEVEL SECURITY`);
    
    return {
      success: true,
      message: `Row-Level Security disabled on ${schema}.${tableName}`,
      details: {
        table: tableName,
        schema
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to disable RLS: ${sanitizeErrorMessage(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Create a Row-Level Security policy
 */
async function _createRLSPolicy(
  connectionString: string,
  tableName: string,
  policyName: string,
  using: string,
  check?: string,
  options: {
    schema?: string;
    command?: 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
    role?: string;
    replace?: boolean;
  } = {}
): Promise<FunctionResult> {
  const db = DatabaseConnection.getInstance();

  try {
    const schema = options.schema || 'public';
    const command = options.command || 'ALL';
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const quotedPolicyName = quoteIdent(policyName);
    const replaceSql = options.replace ? `DROP POLICY IF EXISTS ${quotedPolicyName} ON ${qualifiedTableName};\n` : '';

    // Build policy creation SQL
    let sql = `
      ${replaceSql}CREATE POLICY ${quotedPolicyName}
      ON ${qualifiedTableName}
      FOR ${command}
    `;

    // Add role if specified
    if (options.role) {
      sql += ` TO ${quoteRoleName(options.role)}`;
    }
    
    // Add USING expression
    sql += ` USING (${using})`;
    
    // Add WITH CHECK expression if provided
    if (check) {
      sql += ` WITH CHECK (${check})`;
    }
    
    await db.connect(connectionString);
    await db.query(sql);
    
    return {
      success: true,
      message: `Policy ${policyName} created successfully on ${schema}.${tableName}`,
      details: {
        table: tableName,
        schema,
        policy: policyName,
        command
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to create policy: ${sanitizeErrorMessage(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Drop a Row-Level Security policy
 */
async function _dropRLSPolicy(
  connectionString: string,
  tableName: string,
  policyName: string,
  options: {
    schema?: string;
    ifExists?: boolean;
  } = {}
): Promise<FunctionResult> {
  const db = DatabaseConnection.getInstance();

  try {
    const schema = options.schema || 'public';
    const ifExists = options.ifExists ? 'IF EXISTS' : '';
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const quotedPolicyName = quoteIdent(policyName);

    await db.connect(connectionString);
    await db.query(`DROP POLICY ${ifExists} ${quotedPolicyName} ON ${qualifiedTableName}`);
    
    return {
      success: true,
      message: `Policy ${policyName} dropped successfully from ${schema}.${tableName}`,
      details: {
        table: tableName,
        schema,
        policy: policyName
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to drop policy: ${sanitizeErrorMessage(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Edit an existing Row-Level Security policy
 */
async function _editRLSPolicy(
  connectionString: string,
  tableName: string,
  policyName: string,
  options: {
    schema?: string;
    roles?: string[]; // Use PUBLIC for all roles
    using?: string;
    check?: string;
  } = {}
): Promise<FunctionResult> {
  const db = DatabaseConnection.getInstance();

  try {
    const schema = options.schema || 'public';
    const qualifiedTableName = quoteQualifiedIdent(tableName, schema);
    const quotedPolicyName = quoteIdent(policyName);
    const alterClauses: string[] = [];

    if (options.roles !== undefined) {
      const rolesString = options.roles.length === 0
        ? 'PUBLIC' // Assuming empty array means PUBLIC, adjust if needed
        : options.roles.map(quoteRoleName).join(', ');
      alterClauses.push(`TO ${rolesString}`);
    }

    if (options.using !== undefined) {
      alterClauses.push(`USING (${options.using})`);
    }

    if (options.check !== undefined) {
      // Ensure 'using' is also provided if 'check' is, 
      // or handle the case where only check is altered if allowed by PG version/syntax.
      // PostgreSQL requires re-specifying USING if you alter CHECK.
      // For simplicity, let's assume if check is provided, using should ideally be too,
      // or the user intends to keep the existing 'using'. The ALTER syntax might implicitly handle this.
      // Let's require 'using' if 'check' is provided for clarity, or adjust based on specific PG behavior knowledge.
      if (options.using === undefined) {
          // Decide on behavior: fetch existing 'using', error out, or proceed?
          // Fetching existing 'using' adds complexity. Let's initially require it.
          // throw new Error("The 'using' expression must be provided when altering the 'check' expression.");
          // Alternatively, allow altering only check if syntax supports it, but PG docs suggest USING is needed.
          // Let's focus on altering TO, USING, WITH CHECK where provided.
      }
      alterClauses.push(`WITH CHECK (${options.check})`);
    }

    if (alterClauses.length === 0) {
      return {
        success: false,
        message: 'No changes specified for the policy.',
        details: { table: tableName, schema, policy: policyName }
      };
    }

    const sql = `
      ALTER POLICY ${quotedPolicyName}
      ON ${qualifiedTableName}
      ${alterClauses.join('\n')};
    `;

    await db.connect(connectionString);
    await db.query(sql);

    return {
      success: true,
      message: `Policy ${policyName} on ${schema}.${tableName} updated successfully.`,
      details: {
        table: tableName,
        schema,
        policy: policyName,
        changes: options
      }
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to edit policy: ${sanitizeErrorMessage(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

/**
 * Get Row-Level Security policies for a table
 */
async function _getRLSPolicies(
  connectionString: string,
  tableName?: string,
  schema = 'public'
): Promise<FunctionResult> {
  const db = DatabaseConnection.getInstance();
  
  try {
    await db.connect(connectionString);
    
    let query = `
      SELECT 
        schemaname,
        tablename,
        policyname,
        roles,
        cmd,
        qual as "using",
        with_check as "check"
      FROM pg_policies
      WHERE schemaname = $1
    `;
    
    const params: (string | undefined)[] = [schema];
    
    if (tableName) {
      query += ' AND tablename = $2';
      params.push(tableName);
    }
    
    query += ' ORDER BY tablename, policyname';
    
    const policies = (await db.query<RLSPolicyInfo>(query, params)).map(redactRLSPolicyInfo);
    
    return {
      success: true,
      message: tableName 
        ? `Policies for table ${schema}.${tableName}` 
        : `All policies in schema ${schema}`,
      details: policies
    };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get policies: ${sanitizeErrorMessage(error)}`,
      details: null
    };
  } finally {
    await db.disconnect();
  }
}

// --- Tool Definitions ---

const GetFunctionsInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  functionName: z.string().optional().describe('Optional function name to filter by'),
  schema: z.string().optional().describe('Schema name (defaults to public)')
}).strict();

export const getFunctionsTool: PostgresTool = {
  name: 'pg_get_functions',
  description: 'Get information about PostgreSQL functions',
  inputSchema: GetFunctionsInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = GetFunctionsInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const { connectionString: connStringArg, functionName, schema } = validationResult.data;
    const resolvedConnString = getConnectionStringVal(connStringArg);
    const result = await _getFunctions(resolvedConnString, functionName, schema);
    if (result.success) {
      return { content: [{ type: 'text', text: JSON.stringify(result.details, null, 2) || result.message }] };
    }
    return { content: [{ type: 'text', text: result.message }], isError: true };
  },
};

const CreateFunctionInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  functionName: z.string().describe('Name of the function to create'),
  parameters: z.string().optional().default('').describe('Function parameters. Use empty string "" for functions with no parameters'),
  returnType: z.string().describe('Return type of the function'),
  functionBody: z.string().describe('Function body code'),
  language: z.enum(['sql', 'plpgsql', 'plpython3u']).optional().describe('Function language'),
  volatility: z.enum(['VOLATILE', 'STABLE', 'IMMUTABLE']).optional().describe('Function volatility'),
  schema: z.string().optional().describe('Schema name (defaults to public)'),
  security: z.enum(['INVOKER', 'DEFINER']).optional().describe('Function security context'),
  replace: z.boolean().optional().describe('Whether to replace the function if it exists')
}).strict();

export const createFunctionTool: PostgresTool = {
  name: 'pg_create_function',
  description: 'Create or replace a PostgreSQL function',
  inputSchema: CreateFunctionInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = CreateFunctionInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const {
      connectionString: connStringArg,
      functionName,
      parameters,
      returnType,
      functionBody,
      language,
      volatility,
      schema,
      security,
      replace
    } = validationResult.data;
    try {
      quoteQualifiedIdent(functionName, schema || 'public');
      buildFunctionSignature(parameters);
      const resolvedConnString = getConnectionStringVal(connStringArg);
      const result = await _createFunction(resolvedConnString, functionName, parameters, returnType, functionBody, { language, volatility, schema, security, replace });
      if (result.success) {
        return { content: [{ type: 'text', text: result.message + (result.details ? ` Details: ${JSON.stringify(result.details)}` : '') }] };
      }
      return { content: [{ type: 'text', text: result.message }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error creating function: ${sanitizeErrorMessage(error)}` }], isError: true };
    }
  },
};

const DropFunctionInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  functionName: z.string().describe('Name of the function to drop'),
  parameters: z.string().optional().describe('Function parameters signature (required for overloaded functions)'),
  schema: z.string().optional().describe('Schema name (defaults to public)'),
  ifExists: z.boolean().optional().describe('Whether to include IF EXISTS clause'),
  cascade: z.boolean().optional().describe('Whether to include CASCADE clause')
}).strict();

export const dropFunctionTool: PostgresTool = {
  name: 'pg_drop_function',
  description: 'Drop a PostgreSQL function',
  inputSchema: DropFunctionInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = DropFunctionInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const {
      connectionString: connStringArg,
      functionName,
      parameters,
      schema,
      ifExists,
      cascade
    } = validationResult.data;
    try {
      quoteQualifiedIdent(functionName, schema || 'public');
      buildFunctionSignature(parameters);
      const resolvedConnString = getConnectionStringVal(connStringArg);
      const result = await _dropFunction(resolvedConnString, functionName, parameters, { schema, ifExists, cascade });
      if (result.success) {
        return { content: [{ type: 'text', text: result.message + (result.details ? ` Details: ${JSON.stringify(result.details)}` : '') }] };
      }
      return { content: [{ type: 'text', text: result.message }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error dropping function: ${sanitizeErrorMessage(error)}` }], isError: true };
    }
  },
};

const ToggleRLSInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  tableName: z.string().describe('Name of the table'),
  schema: z.string().optional().describe('Schema name (defaults to public)')
}).strict();

export const enableRLSTool: PostgresTool = {
  name: 'pg_enable_rls',
  description: 'Enable Row-Level Security on a table',
  inputSchema: ToggleRLSInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ToggleRLSInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const { connectionString: connStringArg, tableName, schema } = validationResult.data;
    try {
      quoteQualifiedIdent(tableName, schema || 'public');
      const resolvedConnString = getConnectionStringVal(connStringArg);
      const result = await _enableRLS(resolvedConnString, tableName, schema);
      if (result.success) {
        return { content: [{ type: 'text', text: result.message + (result.details ? ` Details: ${JSON.stringify(result.details)}` : '') }] };
      }
      return { content: [{ type: 'text', text: result.message }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error enabling RLS: ${sanitizeErrorMessage(error)}` }], isError: true };
    }
  }
};

export const disableRLSTool: PostgresTool = {
  name: 'pg_disable_rls',
  description: 'Disable Row-Level Security on a table',
  inputSchema: ToggleRLSInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ToggleRLSInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const { connectionString: connStringArg, tableName, schema } = validationResult.data;
    try {
      quoteQualifiedIdent(tableName, schema || 'public');
      const resolvedConnString = getConnectionStringVal(connStringArg);
      const result = await _disableRLS(resolvedConnString, tableName, schema);
      if (result.success) {
        return { content: [{ type: 'text', text: result.message + (result.details ? ` Details: ${JSON.stringify(result.details)}` : '') }] };
      }
      return { content: [{ type: 'text', text: result.message }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error disabling RLS: ${sanitizeErrorMessage(error)}` }], isError: true };
    }
  }
};

const CreateRLSPolicyInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  tableName: z.string().describe('Name of the table to create policy on'),
  policyName: z.string().describe('Name of the policy to create'),
  using: z.string().describe('USING expression for the policy'),
  check: z.string().optional().describe('WITH CHECK expression for the policy'),
  schema: z.string().optional().describe('Schema name (defaults to public)'),
  command: z.enum(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']).optional().describe('Command the policy applies to'),
  role: z.string().optional().describe('Role the policy applies to'),
  replace: z.boolean().optional().describe('Whether to replace the policy if it exists')
}).strict();

export const createRLSPolicyTool: PostgresTool = {
  name: 'pg_create_rls_policy',
  description: 'Create a Row-Level Security policy',
  inputSchema: CreateRLSPolicyInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = CreateRLSPolicyInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const { connectionString: connStringArg, tableName, policyName, using, check, schema, command, role, replace } = validationResult.data;
    try {
      quoteQualifiedIdent(tableName, schema || 'public');
      quoteIdent(policyName);
      if (role) {
        quoteRoleName(role);
      }
      const resolvedConnString = getConnectionStringVal(connStringArg);
      const result = await _createRLSPolicy(resolvedConnString, tableName, policyName, using, check, { schema, command, role, replace });
      if (result.success) {
        return { content: [{ type: 'text', text: result.message + (result.details ? ` Details: ${JSON.stringify(result.details)}` : '') }] };
      }
      return { content: [{ type: 'text', text: result.message }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error creating RLS policy: ${sanitizeErrorMessage(error)}` }], isError: true };
    }
  }
};

const DropRLSPolicyInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  tableName: z.string().describe('Name of the table the policy is on'),
  policyName: z.string().describe('Name of the policy to drop'),
  schema: z.string().optional().describe('Schema name (defaults to public)'),
  ifExists: z.boolean().optional().describe('Whether to include IF EXISTS clause')
}).strict();

export const dropRLSPolicyTool: PostgresTool = {
  name: 'pg_drop_rls_policy',
  description: 'Drop a Row-Level Security policy',
  inputSchema: DropRLSPolicyInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = DropRLSPolicyInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const { connectionString: connStringArg, tableName, policyName, schema, ifExists } = validationResult.data;
    try {
      quoteQualifiedIdent(tableName, schema || 'public');
      quoteIdent(policyName);
      const resolvedConnString = getConnectionStringVal(connStringArg);
      const result = await _dropRLSPolicy(resolvedConnString, tableName, policyName, { schema, ifExists });
      if (result.success) {
        return { content: [{ type: 'text', text: result.message + (result.details ? ` Details: ${JSON.stringify(result.details)}` : '') }] };
      }
      return { content: [{ type: 'text', text: result.message }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error dropping RLS policy: ${sanitizeErrorMessage(error)}` }], isError: true };
    }
  }
};

const EditRLSPolicyInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  tableName: z.string().describe('Name of the table the policy is on'),
  policyName: z.string().describe('Name of the policy to edit'),
  schema: z.string().optional().describe('Schema name (defaults to public)'),
  roles: z.array(z.string()).optional().describe('New list of roles the policy applies to'),
  using: z.string().optional().describe('New USING expression for the policy'),
  check: z.string().optional().describe('New WITH CHECK expression for the policy')
}).strict();

export const editRLSPolicyTool: PostgresTool = {
  name: 'pg_edit_rls_policy',
  description: 'Edit an existing Row-Level Security policy',
  inputSchema: EditRLSPolicyInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = EditRLSPolicyInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const { connectionString: connStringArg, tableName, policyName, schema, roles, using, check } = validationResult.data;
    try {
      quoteQualifiedIdent(tableName, schema || 'public');
      quoteIdent(policyName);
      if (roles) {
        roles.forEach(quoteRoleName);
      }
      const resolvedConnString = getConnectionStringVal(connStringArg);
      const result = await _editRLSPolicy(resolvedConnString, tableName, policyName, { schema, roles, using, check });
      if (result.success) {
        return { content: [{ type: 'text', text: result.message + (result.details ? ` Details: ${JSON.stringify(result.details)}` : '') }] };
      }
      return { content: [{ type: 'text', text: result.message }], isError: true };
    } catch (error) {
      return { content: [{ type: 'text', text: `Error editing RLS policy: ${sanitizeErrorMessage(error)}` }], isError: true };
    }
  }
};

const GetRLSPoliciesInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  tableName: z.string().optional().describe('Optional table name to filter by'),
  schema: z.string().optional().describe('Schema name (defaults to public)')
}).strict();

export const getRLSPoliciesTool: PostgresTool = {
  name: 'pg_get_rls_policies',
  description: 'Get Row-Level Security policies',
  inputSchema: GetRLSPoliciesInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = GetRLSPoliciesInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const { connectionString: connStringArg, tableName, schema } = validationResult.data;
    const resolvedConnString = getConnectionStringVal(connStringArg);
    const result = await _getRLSPolicies(resolvedConnString, tableName, schema);
    if (result.success) {
      return { content: [{ type: 'text', text: JSON.stringify(result.details, null, 2) || result.message }] };
    }
    return { content: [{ type: 'text', text: result.message }], isError: true };
  }
};

const ManageFunctionsInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['get', 'create', 'drop']).describe('Operation to perform: get (list/info), create (new function), or drop (remove function)'),

  // Common parameters
  functionName: z.string().optional().describe('Name of the function (required for create/drop, optional for get to filter)'),
  schema: z.string().optional().describe('Schema name (defaults to public)'),

  // Create operation parameters
  parameters: z.string().optional().describe('Function parameters - required for create operation, required for drop when function is overloaded. Use empty string "" for functions with no parameters'),
  returnType: z.string().optional().describe('Return type of the function (required for create operation)'),
  functionBody: z.string().optional().describe('Function body code (required for create operation)'),
  language: z.enum(['sql', 'plpgsql', 'plpython3u']).optional().describe('Function language (defaults to plpgsql for create)'),
  volatility: z.enum(['VOLATILE', 'STABLE', 'IMMUTABLE']).optional().describe('Function volatility (defaults to VOLATILE for create)'),
  security: z.enum(['INVOKER', 'DEFINER']).optional().describe('Function security context (defaults to INVOKER for create)'),
  replace: z.boolean().optional().describe('Whether to replace the function if it exists (for create operation)'),

  // Drop operation parameters
  ifExists: z.boolean().optional().describe('Whether to include IF EXISTS clause (for drop operation)'),
  cascade: z.boolean().optional().describe('Whether to include CASCADE clause (for drop operation)')
}).strict();

// Consolidated Functions Management Tool
export const manageFunctionsTool: PostgresTool = {
  name: 'pg_manage_functions',
  description: 'Manage PostgreSQL functions - get, create, or drop functions with a single tool. Examples: operation="get" to list functions, operation="create" with functionName="test_func", parameters="" (empty for no params), returnType="TEXT", functionBody="SELECT \'Hello\'"',
  inputSchema: ManageFunctionsInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ManageFunctionsInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const {
      connectionString: connStringArg,
      operation,
      functionName,
      schema,
      parameters,
      returnType,
      functionBody,
      language,
      volatility,
      security,
      replace,
      ifExists,
      cascade
    } = validationResult.data;

    let result: FunctionResult;

    try {
      switch (operation) {
        case 'get': {
          const resolvedConnString = getConnectionStringVal(connStringArg);
          result = await _getFunctions(resolvedConnString, functionName, schema);
          if (result.success) {
            return { content: [{ type: 'text', text: JSON.stringify(result.details, null, 2) || result.message }] };
          }
          break;
        }

        case 'create': {
          // Fix validation: be more specific about which fields are missing
          const missingFields = [];
          if (!functionName) missingFields.push('functionName');
          if (!returnType) missingFields.push('returnType');
          if (!functionBody) missingFields.push('functionBody');
          
          if (missingFields.length > 0) {
            return {
              content: [{ type: 'text', text: `Error: Missing required fields: ${missingFields.join(', ')}. Note: parameters can be empty string "" for functions with no parameters` }],
              isError: true
            };
          }

          // Normalize parameters: treat undefined, null, or whitespace-only as empty string
          const normalizedParameters: string = parameters === undefined || parameters === null ? '' :
            (typeof parameters === 'string' && parameters.trim() === '') ? '' : String(parameters);
          quoteQualifiedIdent(functionName as string, schema || 'public');
          buildFunctionSignature(normalizedParameters);
          const resolvedConnString = getConnectionStringVal(connStringArg);
          result = await _createFunction(resolvedConnString, functionName as string, normalizedParameters, returnType as string, functionBody as string, {
            language,
            volatility,
            schema,
            security,
            replace
          });
          break;
        }

        case 'drop':
          if (!functionName) {
            return {
              content: [{ type: 'text', text: 'Error: functionName is required for drop operation' }],
              isError: true
            };
          }
          quoteQualifiedIdent(functionName, schema || 'public');
          buildFunctionSignature(parameters);
          const resolvedConnString = getConnectionStringVal(connStringArg);
          result = await _dropFunction(resolvedConnString, functionName, parameters, {
            schema,
            ifExists,
            cascade
          });
          break;

        default:
          return { 
            content: [{ type: 'text', text: `Error: Unknown operation "${operation}". Supported operations: get, create, drop` }], 
            isError: true 
          };
      }

      if (result.success) {
        return { content: [{ type: 'text', text: result.message + (result.details ? ` Details: ${JSON.stringify(result.details)}` : '') }] };
      }
      return { content: [{ type: 'text', text: result.message }], isError: true };

    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error executing ${operation} operation: ${sanitizeErrorMessage(error)}` }],
        isError: true
      };
    }
  }
};

const ManageRLSInputSchema = z.object({
  connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
  operation: z.enum(['enable', 'disable', 'create_policy', 'edit_policy', 'drop_policy', 'get_policies']).describe('Operation: enable/disable RLS, create_policy, edit_policy, drop_policy, get_policies'),

  // Common parameters
  tableName: z.string().optional().describe('Table name (required for enable/disable/create_policy/edit_policy/drop_policy, optional filter for get_policies)'),
  schema: z.string().optional().describe('Schema name (defaults to public)'),

  // Policy-specific parameters
  policyName: z.string().optional().describe('Policy name (required for create_policy/edit_policy/drop_policy)'),
  using: z.string().optional().describe('USING expression for policy (required for create_policy, optional for edit_policy)'),
  check: z.string().optional().describe('WITH CHECK expression for policy (optional for create_policy/edit_policy)'),
  command: z.enum(['ALL', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']).optional().describe('Command the policy applies to (for create_policy)'),
  role: z.string().optional().describe('Role the policy applies to (for create_policy)'),
  replace: z.boolean().optional().describe('Whether to replace policy if exists (for create_policy)'),

  // Edit policy parameters
  roles: z.array(z.string()).optional().describe('List of roles for policy (for edit_policy)'),

  // Drop policy parameters
  ifExists: z.boolean().optional().describe('Include IF EXISTS clause (for drop_policy)')
}).strict();

// Consolidated Row-Level Security Management Tool
export const manageRLSTool: PostgresTool = {
  name: 'pg_manage_rls',
  description: 'Manage PostgreSQL Row-Level Security - enable/disable RLS and manage policies. Examples: operation="enable" with tableName="users", operation="create_policy" with tableName, policyName, using, check',
  inputSchema: ManageRLSInputSchema,
  execute: async (args: unknown, getConnectionStringVal: GetConnectionStringFn): Promise<ToolOutput> => {
    const validationResult = ManageRLSInputSchema.safeParse(args);
    if (!validationResult.success) {
      return { content: [{ type: 'text', text: `Invalid input: ${formatValidationError(validationResult.error)}` }], isError: true };
    }

    const {
      connectionString: connStringArg,
      operation,
      tableName,
      schema,
      policyName,
      using,
      check,
      command,
      role,
      replace,
      roles,
      ifExists
    } = validationResult.data;

    let result: FunctionResult;

    try {
      switch (operation) {
        case 'enable': {
          if (!tableName) {
            return {
              content: [{ type: 'text', text: 'Error: tableName is required for enable operation' }],
              isError: true
            };
          }
          quoteQualifiedIdent(tableName, schema || 'public');
          const resolvedConnString = getConnectionStringVal(connStringArg);
          result = await _enableRLS(resolvedConnString, tableName, schema);
          break;
        }

        case 'disable': {
          if (!tableName) {
            return {
              content: [{ type: 'text', text: 'Error: tableName is required for disable operation' }],
              isError: true
            };
          }
          quoteQualifiedIdent(tableName, schema || 'public');
          const resolvedConnString = getConnectionStringVal(connStringArg);
          result = await _disableRLS(resolvedConnString, tableName, schema);
          break;
        }

        case 'create_policy': {
          if (!tableName || !policyName || !using) {
            return {
              content: [{ type: 'text', text: 'Error: tableName, policyName, and using are required for create_policy operation' }],
              isError: true
            };
          }
          quoteQualifiedIdent(tableName, schema || 'public');
          quoteIdent(policyName);
          if (role) {
            quoteRoleName(role);
          }
          const resolvedConnString = getConnectionStringVal(connStringArg);
          result = await _createRLSPolicy(resolvedConnString, tableName, policyName, using, check, {
            schema,
            command,
            role,
            replace
          });
          break;
        }

        case 'edit_policy': {
          if (!tableName || !policyName) {
            return {
              content: [{ type: 'text', text: 'Error: tableName and policyName are required for edit_policy operation' }],
              isError: true
            };
          }
          quoteQualifiedIdent(tableName, schema || 'public');
          quoteIdent(policyName);
          if (roles) {
            roles.forEach(quoteRoleName);
          }
          const resolvedConnString = getConnectionStringVal(connStringArg);
          result = await _editRLSPolicy(resolvedConnString, tableName, policyName, {
            schema,
            roles,
            using,
            check
          });
          break;
        }

        case 'drop_policy': {
          if (!tableName || !policyName) {
            return {
              content: [{ type: 'text', text: 'Error: tableName and policyName are required for drop_policy operation' }],
              isError: true
            };
          }
          quoteQualifiedIdent(tableName, schema || 'public');
          quoteIdent(policyName);
          const resolvedConnString = getConnectionStringVal(connStringArg);
          result = await _dropRLSPolicy(resolvedConnString, tableName, policyName, {
            schema,
            ifExists
          });
          break;
        }

        case 'get_policies': {
          const resolvedConnString = getConnectionStringVal(connStringArg);
          result = await _getRLSPolicies(resolvedConnString, tableName, schema);
          if (result.success) {
            return { content: [{ type: 'text', text: JSON.stringify(result.details, null, 2) || result.message }] };
          }
          break;
        }

        default:
          return { 
            content: [{ type: 'text', text: `Error: Unknown operation "${operation}". Supported operations: enable, disable, create_policy, edit_policy, drop_policy, get_policies` }], 
            isError: true 
          };
      }

      if (result.success) {
        return { content: [{ type: 'text', text: result.message + (result.details ? ` Details: ${JSON.stringify(result.details)}` : '') }] };
      }
      return { content: [{ type: 'text', text: result.message }], isError: true };

    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error executing ${operation} operation: ${sanitizeErrorMessage(error)}` }],
        isError: true
      };
    }
  }
};
