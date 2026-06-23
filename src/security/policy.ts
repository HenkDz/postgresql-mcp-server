export type SecurityMode = 'readonly' | 'write' | 'admin' | 'unsafe';

export type ToolRisk = 'read' | 'write' | 'ddl' | 'role_admin' | 'filesystem' | 'arbitrary_sql' | 'unclassified';

export interface SecurityPolicy {
  mode: SecurityMode;
  allowDestructive: boolean;
}

export interface ToolCallClassification {
  risk: ToolRisk;
  destructive: boolean;
  reason: string;
}

const MODE_ALLOWANCES: Record<SecurityMode, Set<ToolRisk>> = {
  readonly: new Set(['read']),
  write: new Set(['read', 'write']),
  admin: new Set(['read', 'write', 'ddl', 'role_admin', 'filesystem']),
  unsafe: new Set(['read', 'write', 'ddl', 'role_admin', 'filesystem', 'arbitrary_sql'])
};

const READ_ONLY_TOOLS = new Set([
  'pg_analyze_database',
  'pg_debug_database',
  'pg_execute_query',
  'pg_monitor_database',
  'pg_explain_query',
  'pg_get_enums',
  'pg_get_slow_queries',
  'pg_get_query_stats'
]);

const WRITE_ONLY_TOOLS = new Set([
  'pg_execute_mutation'
]);

const FILESYSTEM_TOOLS = new Set([
  'pg_export_table_data',
  'pg_import_table_data',
  'pg_copy_between_databases'
]);

const ROLE_ADMIN_TOOLS = new Set([
  'pg_create_user',
  'pg_drop_user',
  'pg_alter_user',
  'pg_grant_permissions',
  'pg_revoke_permissions',
  'pg_manage_users'
]);

const DDL_TOOLS = new Set([
  'pg_create_table',
  'pg_alter_table',
  'pg_create_enum',
  'pg_create_index',
  'pg_drop_index',
  'pg_reindex',
  'pg_manage_indexes',
  'pg_create_foreign_key',
  'pg_drop_foreign_key',
  'pg_create_constraint',
  'pg_drop_constraint',
  'pg_manage_constraints',
  'pg_create_function',
  'pg_drop_function',
  'pg_manage_functions',
  'pg_enable_rls',
  'pg_disable_rls',
  'pg_create_rls_policy',
  'pg_drop_rls_policy',
  'pg_edit_rls_policy',
  'pg_manage_rls',
  'pg_create_trigger',
  'pg_drop_trigger',
  'pg_set_trigger_state',
  'pg_manage_triggers',
  'pg_manage_schema',
  'pg_manage_comments',
  'pg_reset_query_stats'
]);

type ManagedOperationPolicy = Record<string, Omit<ToolCallClassification, 'reason'> & { reason: string }>;

const MANAGED_TOOL_POLICIES: Record<string, ManagedOperationPolicy> = {
  pg_manage_schema: {
    get_info: { risk: 'read', destructive: false, reason: 'Schema get_info is read-only.' },
    get_enums: { risk: 'read', destructive: false, reason: 'Schema get_enums is read-only.' },
    create_table: { risk: 'ddl', destructive: false, reason: 'Schema create_table changes database structure.' },
    alter_table: { risk: 'ddl', destructive: true, reason: 'Schema alter_table changes database structure.' },
    create_enum: { risk: 'ddl', destructive: false, reason: 'Schema create_enum changes database structure.' }
  },
  pg_manage_query: {
    explain: { risk: 'read', destructive: false, reason: 'Query explain is read-only.' },
    get_slow_queries: { risk: 'read', destructive: false, reason: 'Query get_slow_queries is read-only.' },
    get_stats: { risk: 'read', destructive: false, reason: 'Query get_stats is read-only.' },
    reset_stats: { risk: 'ddl', destructive: true, reason: 'Query reset_stats changes database statistics state.' }
  },
  pg_manage_indexes: {
    get: { risk: 'read', destructive: false, reason: 'Index get is read-only.' },
    analyze_usage: { risk: 'read', destructive: false, reason: 'Index analyze_usage is read-only.' },
    create: { risk: 'ddl', destructive: false, reason: 'Index create changes database structure.' },
    drop: { risk: 'ddl', destructive: true, reason: 'Index drop changes database structure.' },
    reindex: { risk: 'ddl', destructive: true, reason: 'Index reindex changes database structure.' }
  },
  pg_manage_constraints: {
    get: { risk: 'read', destructive: false, reason: 'Constraint get is read-only.' },
    create_fk: { risk: 'ddl', destructive: false, reason: 'Constraint create_fk changes database structure.' },
    create: { risk: 'ddl', destructive: false, reason: 'Constraint create changes database structure.' },
    drop_fk: { risk: 'ddl', destructive: true, reason: 'Constraint drop_fk changes database structure.' },
    drop: { risk: 'ddl', destructive: true, reason: 'Constraint drop changes database structure.' }
  },
  pg_manage_functions: {
    get: { risk: 'read', destructive: false, reason: 'Function get is read-only.' },
    create: { risk: 'ddl', destructive: false, reason: 'Function create changes executable database code.' },
    drop: { risk: 'ddl', destructive: true, reason: 'Function drop changes executable database code.' }
  },
  pg_manage_rls: {
    get_policies: { risk: 'read', destructive: false, reason: 'RLS get_policies is read-only.' },
    enable: { risk: 'ddl', destructive: false, reason: 'RLS enable changes access policy state.' },
    disable: { risk: 'ddl', destructive: true, reason: 'RLS disable changes access policy state.' },
    create_policy: { risk: 'ddl', destructive: false, reason: 'RLS create_policy changes access policy state.' },
    edit_policy: { risk: 'ddl', destructive: false, reason: 'RLS edit_policy changes access policy state.' },
    drop_policy: { risk: 'ddl', destructive: true, reason: 'RLS drop_policy changes access policy state.' }
  },
  pg_manage_triggers: {
    get: { risk: 'read', destructive: false, reason: 'Trigger get is read-only.' },
    create: { risk: 'ddl', destructive: false, reason: 'Trigger create changes database behavior.' },
    drop: { risk: 'ddl', destructive: true, reason: 'Trigger drop changes database behavior.' },
    set_state: { risk: 'ddl', destructive: true, reason: 'Trigger set_state changes database behavior.' }
  },
  pg_manage_comments: {
    get: { risk: 'read', destructive: false, reason: 'Comment get is read-only.' },
    bulk_get: { risk: 'read', destructive: false, reason: 'Comment bulk_get is read-only.' },
    set: { risk: 'ddl', destructive: false, reason: 'Comment set changes database metadata.' },
    remove: { risk: 'ddl', destructive: true, reason: 'Comment remove changes database metadata.' }
  },
  pg_manage_users: {
    list: { risk: 'read', destructive: false, reason: 'User list is read-only.' },
    get_permissions: { risk: 'read', destructive: false, reason: 'User get_permissions is read-only.' },
    create: { risk: 'role_admin', destructive: false, reason: 'User create changes roles or permissions.' },
    alter: { risk: 'role_admin', destructive: false, reason: 'User alter changes roles or permissions.' },
    grant: { risk: 'role_admin', destructive: false, reason: 'User grant changes roles or permissions.' },
    drop: { risk: 'role_admin', destructive: true, reason: 'User drop changes roles or permissions.' },
    revoke: { risk: 'role_admin', destructive: true, reason: 'User revoke changes roles or permissions.' }
  }
};

function getOperation(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || !('operation' in args)) {
    return undefined;
  }

  const operation = (args as { operation?: unknown }).operation;
  return typeof operation === 'string' ? operation : undefined;
}

function hasRawSchemaDefault(argsObject: Record<string, unknown>): boolean {
  const columns = argsObject.columns;
  if (Array.isArray(columns) && columns.some((column) =>
    column && typeof column === 'object' && typeof (column as Record<string, unknown>).default === 'string'
  )) {
    return true;
  }

  const operations = argsObject.operations;
  return Array.isArray(operations) && operations.some((operation) =>
    operation && typeof operation === 'object' && typeof (operation as Record<string, unknown>).default === 'string'
  );
}

function hasPrivilegeEscalatingRoleAttribute(argsObject: Record<string, unknown>): boolean {
  return ['superuser', 'createdb', 'createrole', 'replication'].some((attribute) => argsObject[attribute] === true);
}

function hasDelegatingOrBroadGrant(argsObject: Record<string, unknown>): boolean {
  const permissions = argsObject.permissions;
  return argsObject.withGrantOption === true ||
    (Array.isArray(permissions) && permissions.some((permission) => permission === 'ALL' || permission === 'TRUNCATE'));
}

function classifyManagedTool(toolName: string, operation: string | undefined): ToolCallClassification | null {
  const operationPolicies = MANAGED_TOOL_POLICIES[toolName];
  if (!operationPolicies) {
    return null;
  }

  if (operation && operation in operationPolicies) {
    return operationPolicies[operation];
  }

  return {
    risk: 'unclassified',
    destructive: true,
    reason: `${toolName} operation "${operation || '<missing>'}" is not explicitly classified by the security policy.`
  };
}

export function normalizeSecurityMode(mode: unknown): SecurityMode {
  if (mode === undefined || mode === null || mode === '') {
    return 'readonly';
  }

  if (mode === 'write' || mode === 'admin' || mode === 'unsafe') {
    return mode;
  }

  if (mode === 'readonly') {
    return 'readonly';
  }

  throw new Error('securityMode must be one of readonly, write, admin, or unsafe.');
}

export function classifyToolCall(toolName: string, args: unknown): ToolCallClassification {
  if (toolName === 'pg_execute_sql') {
    return { risk: 'arbitrary_sql', destructive: true, reason: 'Arbitrary SQL can read, write, change schema, or change roles.' };
  }

  const operation = getOperation(args);
  const argsObject = args && typeof args === 'object' ? args as Record<string, unknown> : {};
  if (
    (toolName === 'pg_create_index' || (toolName === 'pg_manage_indexes' && operation === 'create')) &&
    (typeof argsObject.where === 'string' || typeof argsObject.rawWhere === 'string')
  ) {
    return {
      risk: 'arbitrary_sql',
      destructive: true,
      reason: `${toolName} includes a raw SQL partial-index predicate.`
    };
  }
  if (
    ((toolName === 'pg_manage_query' && operation === 'explain') || toolName === 'pg_explain_query') &&
    argsObject.analyze === true
  ) {
    return {
      risk: 'arbitrary_sql',
      destructive: true,
      reason: 'EXPLAIN ANALYZE executes the supplied SQL query.'
    };
  }
  if (
    (toolName === 'pg_create_constraint' || (toolName === 'pg_manage_constraints' && operation === 'create')) &&
    typeof argsObject.checkExpression === 'string'
  ) {
    return {
      risk: 'arbitrary_sql',
      destructive: true,
      reason: `${toolName} includes a raw SQL CHECK expression.`
    };
  }
  if (
    (toolName === 'pg_create_table' || toolName === 'pg_alter_table' ||
      ((toolName === 'pg_manage_schema') && (operation === 'create_table' || operation === 'alter_table'))) &&
    hasRawSchemaDefault(argsObject)
  ) {
    return {
      risk: 'arbitrary_sql',
      destructive: true,
      reason: `${toolName} includes a raw SQL column default expression.`
    };
  }
  if (toolName === 'pg_create_function' || (toolName === 'pg_manage_functions' && operation === 'create')) {
    return {
      risk: 'arbitrary_sql',
      destructive: true,
      reason: `${toolName} creates executable database code from raw SQL input.`
    };
  }
  if (
    toolName === 'pg_create_rls_policy' ||
    (toolName === 'pg_manage_rls' && operation === 'create_policy') ||
    ((toolName === 'pg_edit_rls_policy' || (toolName === 'pg_manage_rls' && operation === 'edit_policy')) &&
      (typeof argsObject.using === 'string' || typeof argsObject.check === 'string'))
  ) {
    return {
      risk: 'arbitrary_sql',
      destructive: true,
      reason: `${toolName} includes raw SQL RLS policy expressions.`
    };
  }
  if (
    (toolName === 'pg_create_trigger' || (toolName === 'pg_manage_triggers' && operation === 'create')) &&
    typeof argsObject.when === 'string'
  ) {
    return {
      risk: 'arbitrary_sql',
      destructive: true,
      reason: `${toolName} includes a raw SQL trigger WHEN expression.`
    };
  }
  if (
    (toolName === 'pg_create_user' || (toolName === 'pg_manage_users' && operation === 'create')) &&
    hasPrivilegeEscalatingRoleAttribute(argsObject)
  ) {
    return {
      risk: 'role_admin',
      destructive: true,
      reason: `${toolName} creates a role with elevated PostgreSQL attributes.`
    };
  }
  if (
    (toolName === 'pg_alter_user' || (toolName === 'pg_manage_users' && operation === 'alter')) &&
    hasPrivilegeEscalatingRoleAttribute(argsObject)
  ) {
    return {
      risk: 'role_admin',
      destructive: true,
      reason: `${toolName} grants elevated PostgreSQL role attributes.`
    };
  }
  if (
    (toolName === 'pg_grant_permissions' || (toolName === 'pg_manage_users' && operation === 'grant')) &&
    hasDelegatingOrBroadGrant(argsObject)
  ) {
    return {
      risk: 'role_admin',
      destructive: true,
      reason: `${toolName} grants broad or delegable PostgreSQL permissions.`
    };
  }

  const managedClassification = classifyManagedTool(toolName, operation);
  if (managedClassification) {
    return managedClassification;
  }

  if (READ_ONLY_TOOLS.has(toolName)) {
    return { risk: 'read', destructive: false, reason: `${toolName} is classified as read-only.` };
  }

  if (WRITE_ONLY_TOOLS.has(toolName)) {
    if (typeof argsObject.where === 'string' || typeof argsObject.rawWhere === 'string') {
      return {
        risk: 'arbitrary_sql',
        destructive: true,
        reason: `${toolName} includes a raw SQL WHERE fragment.`
      };
    }

    return {
      risk: 'write',
      destructive: operation === 'delete',
      reason: `${toolName} performs data mutation operations.`
    };
  }

  if (FILESYSTEM_TOOLS.has(toolName)) {
    const argsObject = args && typeof args === 'object' ? args as Record<string, unknown> : {};
    if (typeof argsObject.where === 'string' || typeof argsObject.rawWhere === 'string') {
      return {
        risk: 'arbitrary_sql',
        destructive: true,
        reason: `${toolName} includes a raw SQL WHERE fragment.`
      };
    }

    return {
      risk: 'filesystem',
      destructive: toolName !== 'pg_export_table_data',
      reason: `${toolName} reads or writes local files and may move data between trust boundaries.`
    };
  }

  if (ROLE_ADMIN_TOOLS.has(toolName)) {
    return {
      risk: 'role_admin',
      destructive: toolName === 'pg_drop_user' || toolName === 'pg_revoke_permissions',
      reason: `${toolName} changes roles or permissions.`
    };
  }

  if (DDL_TOOLS.has(toolName)) {
    return {
      risk: 'ddl',
      destructive: toolName.includes('_drop_') || toolName === 'pg_reindex' || toolName === 'pg_reset_query_stats',
      reason: `${toolName} changes database structure or behavior.`
    };
  }

  return {
    risk: 'unclassified',
    destructive: true,
    reason: `${toolName} is not explicitly classified by the security policy.`
  };
}

export function isToolCallAllowed(policy: SecurityPolicy, classification: ToolCallClassification): boolean {
  if (!MODE_ALLOWANCES[policy.mode].has(classification.risk)) {
    return false;
  }

  if (classification.destructive && !policy.allowDestructive) {
    return false;
  }

  return true;
}

export function explainPolicyDenial(policy: SecurityPolicy, classification: ToolCallClassification): string {
  if (classification.destructive && MODE_ALLOWANCES[policy.mode].has(classification.risk) && !policy.allowDestructive) {
    return `Blocked by PostgreSQL MCP security policy: ${classification.reason} Destructive operations require allowDestructive=true.`;
  }

  return `Blocked by PostgreSQL MCP security policy: ${classification.reason} Current mode "${policy.mode}" allows ${Array.from(MODE_ALLOWANCES[policy.mode]).join(', ')} operations.`;
}
