import { describe, expect, it } from 'vitest';
import {
  classifyToolCall,
  explainPolicyDenial,
  isToolCallAllowed,
  normalizeSecurityMode,
  type ToolRisk,
  type SecurityPolicy
} from './policy';
import { allTools } from '../index';
import { zodToJsonSchema } from 'zod-to-json-schema';

const readonlyPolicy: SecurityPolicy = { mode: 'readonly', allowDestructive: false };
const writePolicy: SecurityPolicy = { mode: 'write', allowDestructive: false };
const adminPolicy: SecurityPolicy = { mode: 'admin', allowDestructive: false };
const destructiveAdminPolicy: SecurityPolicy = { mode: 'admin', allowDestructive: true };
const unsafePolicy: SecurityPolicy = { mode: 'unsafe', allowDestructive: true };

const operationPolicyExpectations = {
  pg_manage_schema: {
    get_info: ['read', false],
    get_enums: ['read', false],
    create_table: ['ddl', false],
    alter_table: ['ddl', true],
    create_enum: ['ddl', false]
  },
  pg_manage_query: {
    explain: ['read', false],
    get_slow_queries: ['read', false],
    get_stats: ['read', false],
    reset_stats: ['ddl', true]
  },
  pg_manage_indexes: {
    get: ['read', false],
    analyze_usage: ['read', false],
    create: ['ddl', false],
    drop: ['ddl', true],
    reindex: ['ddl', true]
  },
  pg_manage_constraints: {
    get: ['read', false],
    create_fk: ['ddl', false],
    create: ['ddl', false],
    drop_fk: ['ddl', true],
    drop: ['ddl', true]
  },
  pg_manage_functions: {
    get: ['read', false],
    create: ['arbitrary_sql', true],
    drop: ['ddl', true]
  },
  pg_manage_rls: {
    get_policies: ['read', false],
    enable: ['ddl', false],
    disable: ['ddl', true],
    create_policy: ['arbitrary_sql', true],
    edit_policy: ['ddl', false],
    drop_policy: ['ddl', true]
  },
  pg_manage_triggers: {
    get: ['read', false],
    create: ['ddl', false],
    drop: ['ddl', true],
    set_state: ['ddl', true]
  },
  pg_manage_comments: {
    get: ['read', false],
    bulk_get: ['read', false],
    set: ['ddl', false],
    remove: ['ddl', true]
  },
  pg_manage_users: {
    list: ['read', false],
    get_permissions: ['read', false],
    create: ['role_admin', false],
    alter: ['role_admin', false],
    grant: ['role_admin', false],
    drop: ['role_admin', true],
    revoke: ['role_admin', true]
  },
  pg_execute_query: {
    select: ['read', false],
    count: ['read', false],
    exists: ['read', false]
  },
  pg_execute_mutation: {
    insert: ['write', false],
    update: ['write', false],
    delete: ['write', true],
    upsert: ['write', false]
  }
} satisfies Record<string, Record<string, [ToolRisk, boolean]>>;

function runtimeOperationEnums(): Record<string, string[]> {
  const operationEnums: Record<string, string[]> = {};

  for (const tool of allTools) {
    const schema = zodToJsonSchema(tool.inputSchema) as {
      properties?: {
        operation?: {
          enum?: unknown[];
        };
      };
    };
    const enumValues = schema.properties?.operation?.enum;

    if (enumValues) {
      operationEnums[tool.name] = enumValues.filter((value): value is string => typeof value === 'string');
    }
  }

  return operationEnums;
}

describe('security policy', () => {
  it('defaults absent modes to readonly and rejects invalid explicit modes', () => {
    expect(normalizeSecurityMode(undefined)).toBe('readonly');
    expect(normalizeSecurityMode('')).toBe('readonly');
    expect(() => normalizeSecurityMode('invalid')).toThrow('securityMode must be one of readonly, write, admin, or unsafe');
    expect(normalizeSecurityMode('readonly')).toBe('readonly');
    expect(normalizeSecurityMode('write')).toBe('write');
    expect(normalizeSecurityMode('admin')).toBe('admin');
    expect(normalizeSecurityMode('unsafe')).toBe('unsafe');
  });

  it('allows read operations in readonly mode', () => {
    const classification = classifyToolCall('pg_manage_schema', { operation: 'get_info' });

    expect(classification.risk).toBe('read');
    expect(isToolCallAllowed(readonlyPolicy, classification)).toBe(true);
  });

  it('blocks schema writes in readonly mode', () => {
    const classification = classifyToolCall('pg_manage_schema', { operation: 'create_table' });

    expect(classification.risk).toBe('ddl');
    expect(isToolCallAllowed(readonlyPolicy, classification)).toBe(false);
    expect(explainPolicyDenial(readonlyPolicy, classification)).toContain('Current mode "readonly"');
  });

  it('allows mutation in write mode but blocks it in readonly mode', () => {
    const classification = classifyToolCall('pg_execute_mutation', { operation: 'insert' });

    expect(classification.risk).toBe('write');
    expect(isToolCallAllowed(readonlyPolicy, classification)).toBe(false);
    expect(isToolCallAllowed(writePolicy, classification)).toBe(true);
  });

  it('treats raw mutation SQL fragments as unsafe', () => {
    const legacyWhere = classifyToolCall('pg_execute_mutation', { operation: 'update', where: 'id = 1' });
    const rawWhere = classifyToolCall('pg_execute_mutation', { operation: 'delete', rawWhere: 'id = 1' });
    const structuredWhere = classifyToolCall('pg_execute_mutation', { operation: 'update', where: { id: 1 } });

    expect(legacyWhere.risk).toBe('arbitrary_sql');
    expect(rawWhere.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(writePolicy, legacyWhere)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, legacyWhere)).toBe(true);
    expect(structuredWhere.risk).toBe('write');
    expect(isToolCallAllowed(writePolicy, structuredWhere)).toBe(true);
  });

  it('treats raw migration SQL fragments as unsafe', () => {
    const rawExport = classifyToolCall('pg_export_table_data', { where: 'id = 1' });
    const structuredExport = classifyToolCall('pg_export_table_data', { where: { id: 1 } });

    expect(rawExport.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(adminPolicy, rawExport)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, rawExport)).toBe(true);
    expect(structuredExport.risk).toBe('filesystem');
    expect(isToolCallAllowed(adminPolicy, structuredExport)).toBe(true);
  });

  it('treats raw partial-index predicates as unsafe', () => {
    const rawIndex = classifyToolCall('pg_manage_indexes', {
      operation: 'create',
      where: 'deleted_at IS NULL'
    });
    const structuredIndex = classifyToolCall('pg_manage_indexes', {
      operation: 'create',
      where: { deleted_at: { isNull: true } }
    });

    expect(rawIndex.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(adminPolicy, rawIndex)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, rawIndex)).toBe(true);
    expect(structuredIndex.risk).toBe('ddl');
    expect(isToolCallAllowed(adminPolicy, structuredIndex)).toBe(true);
  });

  it('treats raw CHECK expressions as unsafe', () => {
    const checkConstraint = classifyToolCall('pg_manage_constraints', {
      operation: 'create',
      constraintTypeCreate: 'check',
      checkExpression: 'price > 0'
    });
    const uniqueConstraint = classifyToolCall('pg_manage_constraints', {
      operation: 'create',
      constraintTypeCreate: 'unique',
      columnNames: ['email']
    });

    expect(checkConstraint.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(adminPolicy, checkConstraint)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, checkConstraint)).toBe(true);
    expect(uniqueConstraint.risk).toBe('ddl');
    expect(isToolCallAllowed(adminPolicy, uniqueConstraint)).toBe(true);
  });

  it('treats raw schema default expressions as unsafe', () => {
    const createWithDefault = classifyToolCall('pg_manage_schema', {
      operation: 'create_table',
      tableName: 'users',
      columns: [{ name: 'created_at', type: 'timestamp', default: 'now()' }]
    });
    const createWithoutDefault = classifyToolCall('pg_manage_schema', {
      operation: 'create_table',
      tableName: 'users',
      columns: [{ name: 'created_at', type: 'timestamp' }]
    });

    expect(createWithDefault.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(adminPolicy, createWithDefault)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, createWithDefault)).toBe(true);
    expect(createWithoutDefault.risk).toBe('ddl');
    expect(isToolCallAllowed(adminPolicy, createWithoutDefault)).toBe(true);
  });

  it('treats EXPLAIN ANALYZE as unsafe because it executes supplied SQL', () => {
    const explainOnly = classifyToolCall('pg_manage_query', {
      operation: 'explain',
      query: 'SELECT 1',
      analyze: false
    });
    const explainAnalyze = classifyToolCall('pg_manage_query', {
      operation: 'explain',
      query: 'SELECT 1',
      analyze: true
    });

    expect(explainOnly.risk).toBe('read');
    expect(isToolCallAllowed(readonlyPolicy, explainOnly)).toBe(true);
    expect(explainAnalyze.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(adminPolicy, explainAnalyze)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, explainAnalyze)).toBe(true);
  });

  it('classifies legacy direct performance tools consistently', () => {
    const directExplain = classifyToolCall('pg_explain_query', {
      query: 'SELECT 1',
      analyze: false
    });
    const directAnalyze = classifyToolCall('pg_explain_query', {
      query: 'SELECT 1',
      analyze: true
    });
    const resetStats = classifyToolCall('pg_reset_query_stats', {});

    expect(directExplain.risk).toBe('read');
    expect(isToolCallAllowed(readonlyPolicy, directExplain)).toBe(true);
    expect(directAnalyze.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(adminPolicy, directAnalyze)).toBe(false);
    expect(resetStats.risk).toBe('ddl');
    expect(resetStats.destructive).toBe(true);
    expect(isToolCallAllowed(adminPolicy, resetStats)).toBe(false);
    expect(isToolCallAllowed(destructiveAdminPolicy, resetStats)).toBe(true);
  });

  it('classifies legacy direct enum tools consistently', () => {
    const getEnums = classifyToolCall('pg_get_enums', {});
    const createEnum = classifyToolCall('pg_create_enum', {});

    expect(getEnums.risk).toBe('read');
    expect(isToolCallAllowed(readonlyPolicy, getEnums)).toBe(true);
    expect(createEnum.risk).toBe('ddl');
    expect(isToolCallAllowed(adminPolicy, createEnum)).toBe(true);
  });

  it('treats function creation as unsafe executable SQL', () => {
    const createFunction = classifyToolCall('pg_manage_functions', {
      operation: 'create',
      functionName: 'calculate_total',
      parameters: 'price DECIMAL',
      returnType: 'DECIMAL',
      functionBody: 'SELECT price'
    });
    const dropFunction = classifyToolCall('pg_manage_functions', {
      operation: 'drop',
      functionName: 'old_func'
    });

    expect(createFunction.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(adminPolicy, createFunction)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, createFunction)).toBe(true);
    expect(dropFunction.risk).toBe('ddl');
    expect(dropFunction.destructive).toBe(true);
  });

  it('treats raw RLS policy expressions as unsafe', () => {
    const createPolicy = classifyToolCall('pg_manage_rls', {
      operation: 'create_policy',
      tableName: 'users',
      policyName: 'user_isolation',
      using: 'user_id = current_user_id()'
    });
    const editRolesOnly = classifyToolCall('pg_manage_rls', {
      operation: 'edit_policy',
      tableName: 'users',
      policyName: 'user_isolation',
      roles: ['authenticated']
    });
    const editExpression = classifyToolCall('pg_manage_rls', {
      operation: 'edit_policy',
      tableName: 'users',
      policyName: 'user_isolation',
      using: 'tenant_id = current_tenant_id()'
    });

    expect(createPolicy.risk).toBe('arbitrary_sql');
    expect(editExpression.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(adminPolicy, createPolicy)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, createPolicy)).toBe(true);
    expect(editRolesOnly.risk).toBe('ddl');
    expect(isToolCallAllowed(adminPolicy, editRolesOnly)).toBe(true);
  });

  it('treats raw trigger WHEN expressions as unsafe', () => {
    const rawTrigger = classifyToolCall('pg_manage_triggers', {
      operation: 'create',
      triggerName: 'audit_trigger',
      tableName: 'users',
      functionName: 'audit_function',
      when: 'NEW.active = true'
    });
    const triggerWithoutWhen = classifyToolCall('pg_manage_triggers', {
      operation: 'create',
      triggerName: 'audit_trigger',
      tableName: 'users',
      functionName: 'audit_function'
    });

    expect(rawTrigger.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(adminPolicy, rawTrigger)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, rawTrigger)).toBe(true);
    expect(triggerWithoutWhen.risk).toBe('ddl');
    expect(isToolCallAllowed(adminPolicy, triggerWithoutWhen)).toBe(true);
  });

  it('requires destructive opt-in even when the mode otherwise allows the risk', () => {
    const classification = classifyToolCall('pg_manage_indexes', { operation: 'drop' });

    expect(classification.risk).toBe('ddl');
    expect(classification.destructive).toBe(true);
    expect(isToolCallAllowed(adminPolicy, classification)).toBe(false);
    expect(isToolCallAllowed(destructiveAdminPolicy, classification)).toBe(true);
  });

  it('requires unsafe mode for arbitrary SQL', () => {
    const classification = classifyToolCall('pg_execute_sql', { sql: 'SELECT 1' });

    expect(classification.risk).toBe('arbitrary_sql');
    expect(isToolCallAllowed(readonlyPolicy, classification)).toBe(false);
    expect(isToolCallAllowed(writePolicy, classification)).toBe(false);
    expect(isToolCallAllowed(destructiveAdminPolicy, classification)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, classification)).toBe(true);
  });

  it('keeps read-only operations available inside mixed meta-tools', () => {
    expect(isToolCallAllowed(readonlyPolicy, classifyToolCall('pg_manage_users', { operation: 'list' }))).toBe(true);
    expect(isToolCallAllowed(readonlyPolicy, classifyToolCall('pg_manage_users', { operation: 'create' }))).toBe(false);
    expect(isToolCallAllowed(readonlyPolicy, classifyToolCall('pg_manage_comments', { operation: 'get' }))).toBe(true);
    expect(isToolCallAllowed(readonlyPolicy, classifyToolCall('pg_manage_comments', { operation: 'set' }))).toBe(false);
  });

  it('requires destructive opt-in for privilege-escalating role attributes', () => {
    const regularCreate = classifyToolCall('pg_manage_users', {
      operation: 'create',
      username: 'reporting_user'
    });
    const superuserCreate = classifyToolCall('pg_manage_users', {
      operation: 'create',
      username: 'break_glass',
      superuser: true
    });
    const createdbAlter = classifyToolCall('pg_alter_user', {
      username: 'migrator',
      createdb: true
    });
    const reducePrivileges = classifyToolCall('pg_manage_users', {
      operation: 'alter',
      username: 'migrator',
      createrole: false
    });

    expect(regularCreate.risk).toBe('role_admin');
    expect(regularCreate.destructive).toBe(false);
    expect(superuserCreate.risk).toBe('role_admin');
    expect(superuserCreate.destructive).toBe(true);
    expect(createdbAlter.risk).toBe('role_admin');
    expect(createdbAlter.destructive).toBe(true);
    expect(reducePrivileges.destructive).toBe(false);
    expect(isToolCallAllowed(adminPolicy, superuserCreate)).toBe(false);
    expect(isToolCallAllowed(destructiveAdminPolicy, superuserCreate)).toBe(true);
  });

  it('requires destructive opt-in for broad or delegable grants', () => {
    const regularGrant = classifyToolCall('pg_manage_users', {
      operation: 'grant',
      permissions: ['SELECT']
    });
    const delegableGrant = classifyToolCall('pg_manage_users', {
      operation: 'grant',
      permissions: ['SELECT'],
      withGrantOption: true
    });
    const allGrant = classifyToolCall('pg_grant_permissions', {
      permissions: ['ALL']
    });
    const truncateGrant = classifyToolCall('pg_manage_users', {
      operation: 'grant',
      permissions: ['TRUNCATE']
    });

    expect(regularGrant.risk).toBe('role_admin');
    expect(regularGrant.destructive).toBe(false);
    expect(delegableGrant.destructive).toBe(true);
    expect(allGrant.destructive).toBe(true);
    expect(truncateGrant.destructive).toBe(true);
    expect(isToolCallAllowed(adminPolicy, delegableGrant)).toBe(false);
    expect(isToolCallAllowed(destructiveAdminPolicy, delegableGrant)).toBe(true);
  });

  it('has explicit policy expectations for every runtime operation enum', () => {
    const runtimeEnums = runtimeOperationEnums();
    const expectedToolNames = Object.keys(operationPolicyExpectations).sort();
    const runtimeToolNames = Object.keys(runtimeEnums).sort();

    expect(expectedToolNames).toEqual(runtimeToolNames);

    for (const [toolName, operations] of Object.entries(runtimeEnums)) {
      const expectedOperations = Object.keys(operationPolicyExpectations[toolName]).sort();
      expect([...operations].sort()).toEqual(expectedOperations);

      for (const operation of operations) {
        const [expectedRisk, expectedDestructive] = operationPolicyExpectations[toolName][operation];
        const args = { operation };
        const classification = classifyToolCall(toolName, args);

        expect(classification.risk, `${toolName}.${operation} risk`).toBe(expectedRisk);
        expect(classification.destructive, `${toolName}.${operation} destructive`).toBe(expectedDestructive);
        expect(classification.risk, `${toolName}.${operation} must be explicitly classified`).not.toBe('unclassified');
      }
    }
  });

  it('fails closed for unclassified tools and unclassified managed operations', () => {
    const unclassifiedTool = classifyToolCall('pg_future_tool', {});
    const unclassifiedOperation = classifyToolCall('pg_manage_schema', { operation: 'future_operation' });

    expect(unclassifiedTool.risk).toBe('unclassified');
    expect(unclassifiedOperation.risk).toBe('unclassified');
    expect(isToolCallAllowed(destructiveAdminPolicy, unclassifiedTool)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, unclassifiedTool)).toBe(false);
    expect(isToolCallAllowed(destructiveAdminPolicy, unclassifiedOperation)).toBe(false);
    expect(isToolCallAllowed(unsafePolicy, unclassifiedOperation)).toBe(false);
    expect(explainPolicyDenial(unsafePolicy, unclassifiedOperation)).toContain('not explicitly classified');
  });
});
