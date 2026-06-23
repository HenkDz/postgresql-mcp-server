import { afterEach, describe, expect, it, vi } from 'vitest';
import { DatabaseConnection } from '../utils/connection';
import {
  createFunctionTool,
  createRLSPolicyTool,
  dropFunctionTool,
  editRLSPolicyTool,
  enableRLSTool,
  getFunctionsTool,
  manageFunctionsTool,
  manageRLSTool
} from './functions';

describe('manageFunctionsTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('creates functions with quoted function identifiers and collision-safe dollar quotes', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageFunctionsTool.execute({
      operation: 'create',
      functionName: 'calculate_total',
      schema: 'billing',
      parameters: 'price DECIMAL, tax DECIMAL',
      returnType: 'DECIMAL',
      functionBody: 'BEGIN RETURN price + (price * tax); END;',
      language: 'plpgsql',
      volatility: 'STABLE',
      security: 'INVOKER'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const sql = mockDb.query.mock.calls[0][0] as string;
    expect(sql).toContain('CREATE FUNCTION "billing"."calculate_total"(price DECIMAL, tax DECIMAL)');
    expect(sql).toContain('RETURNS DECIMAL');
    expect(sql).toContain('LANGUAGE plpgsql');
    expect(sql).toContain('STABLE');
    expect(sql).toContain('SECURITY INVOKER');
    expect(sql).toContain('AS $function$');
  });

  it('drops functions with quoted identifiers and validated signatures', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageFunctionsTool.execute({
      operation: 'drop',
      functionName: 'old_func',
      schema: 'billing',
      parameters: 'INT, TEXT',
      ifExists: true,
      cascade: true
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('DROP FUNCTION IF EXISTS "billing"."old_func"(INT, TEXT) CASCADE');
  });

  it('redacts function definitions returned from catalog lookups', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{
        name: 'leaky_func',
        language: 'plpgsql',
        returnType: 'text',
        arguments: '',
        definition: "CREATE FUNCTION leaky_func() RETURNS text LANGUAGE sql AS $$ SELECT 'raw-function-secret' $$",
        volatility: 'VOLATILE',
        owner: 'app'
      }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageFunctionsTool.execute({
      operation: 'get',
      functionName: 'leaky_func'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain('AS $$?$$');
    expect(output).not.toContain('raw-function-secret');
  });

  it('sanitizes create function database errors before returning them', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed while compiling SELECT 'raw-token'")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageFunctionsTool.execute({
      operation: 'create',
      functionName: 'leaky_func',
      parameters: '',
      returnType: 'TEXT',
      functionBody: "BEGIN RETURN 'raw-token'; END;",
      language: 'plpgsql',
      volatility: 'VOLATILE',
      security: 'INVOKER'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to create function');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("SELECT '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('raw-token');
  });

  it('rejects unknown function-management fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageFunctionsTool.execute({
      operation: 'create',
      functionName: 'leaky_func',
      parameters: '',
      returnType: 'TEXT',
      functionBody: "SELECT 'x'",
      rawSql: 'DROP FUNCTION leaky_func()'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects invalid function-management option values before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageFunctionsTool.execute({
      operation: 'create',
      functionName: 'leaky_func',
      parameters: '',
      returnType: 'TEXT',
      functionBody: "SELECT 'x'",
      language: 'plperlu'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('language');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe function identifiers before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageFunctionsTool.execute({
      operation: 'drop',
      functionName: 'old_func; drop schema public',
      parameters: 'INT'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects missing create-function fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageFunctionsTool.execute({
      operation: 'create',
      functionName: 'missing_body',
      returnType: 'TEXT'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Missing required fields');
    expect(result.content[0].text).toContain('functionBody');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe function signatures before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageFunctionsTool.execute({
      operation: 'drop',
      functionName: 'old_func',
      parameters: 'INT); drop function old_func'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid function signature');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe('legacy direct function and RLS tools', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('rejects unknown direct function fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createFunctionTool.execute({
      functionName: 'leaky_func',
      returnType: 'TEXT',
      functionBody: "SELECT 'x'",
      rawSql: 'DROP FUNCTION leaky_func()'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects invalid direct function fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createFunctionTool.execute({
      functionName: 'leaky_func',
      returnType: 'TEXT',
      functionBody: "SELECT 'x'",
      language: 'plperlu'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('language');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unknown direct function listing fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await getFunctionsTool.execute({
      functionName: 'leaky_func',
      rawSql: 'SELECT pg_get_functiondef(oid)'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects invalid direct RLS policy fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createRLSPolicyTool.execute({
      tableName: 'users',
      policyName: 'tenant_policy',
      using: 'true',
      command: 'MERGE'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('command');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe direct function identifiers before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await createFunctionTool.execute({
      functionName: 'leaky_func; drop schema public',
      returnType: 'TEXT',
      functionBody: "SELECT 'x'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe direct function signatures before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await dropFunctionTool.execute({
      functionName: 'leaky_func',
      parameters: 'INT); drop function leaky_func'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid function signature');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe direct RLS table identifiers before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await enableRLSTool.execute({
      tableName: 'users; drop table users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe direct RLS roles before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await editRLSPolicyTool.execute({
      tableName: 'users',
      policyName: 'tenant_policy',
      roles: ['authenticated; drop role authenticated']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});

describe('manageRLSTool', () => {
  const mockGetConnectionString = vi.fn().mockReturnValue('postgresql://test');

  afterEach(() => {
    vi.restoreAllMocks();
    mockGetConnectionString.mockClear();
  });

  it('enables RLS with quoted table identifiers', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageRLSTool.execute({
      operation: 'enable',
      tableName: 'users',
      schema: 'auth'
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledWith('ALTER TABLE "auth"."users" ENABLE ROW LEVEL SECURITY');
  });

  it('creates RLS policies with quoted policy, table, and role identifiers', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageRLSTool.execute({
      operation: 'create_policy',
      tableName: 'users',
      policyName: 'user_isolation',
      using: 'user_id = current_user_id()',
      check: 'user_id = current_user_id()',
      command: 'SELECT',
      role: 'authenticated',
      replace: true
    }, mockGetConnectionString);

    expect(result.isError).toBeUndefined();
    expect(mockDb.query).toHaveBeenCalledTimes(1);
    const sql = mockDb.query.mock.calls[0][0] as string;
    expect(sql).toContain('DROP POLICY IF EXISTS "user_isolation" ON "users";');
    expect(sql).toContain('CREATE POLICY "user_isolation"');
    expect(sql).toContain('ON "users"');
    expect(sql).toContain('FOR SELECT');
    expect(sql).toContain('TO "authenticated"');
    expect(sql).toContain('USING (user_id = current_user_id())');
    expect(sql).toContain('WITH CHECK (user_id = current_user_id())');
  });

  it('redacts RLS policy expressions returned from catalog lookups', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([{
        schemaname: 'public',
        tablename: 'users',
        policyname: 'tenant_policy',
        roles: ['public'],
        cmd: 'SELECT',
        using: "tenant_id = 'tenant-secret'",
        check: "tenant_id = 'tenant-secret'"
      }]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageRLSTool.execute({
      operation: 'get_policies',
      tableName: 'users'
    }, mockGetConnectionString);

    const output = result.content.map((item) => item.text).join('\n');
    expect(result.isError).toBeUndefined();
    expect(output).toContain("tenant_id = '?'");
    expect(output).not.toContain('tenant-secret');
  });

  it('sanitizes RLS policy database errors before returning them', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockRejectedValue(
        new Error("password=db-secret failed near USING (tenant_id = 'tenant-secret')")
      ),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageRLSTool.execute({
      operation: 'create_policy',
      tableName: 'users',
      policyName: 'tenant_policy',
      using: "tenant_id = 'tenant-secret'"
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Failed to create policy');
    expect(result.content[0].text).toContain('password=*****');
    expect(result.content[0].text).toContain("tenant_id = '?'");
    expect(result.content[0].text).not.toContain('db-secret');
    expect(result.content[0].text).not.toContain('tenant-secret');
  });

  it('rejects unknown RLS-management fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageRLSTool.execute({
      operation: 'create_policy',
      tableName: 'users',
      policyName: 'tenant_policy',
      using: 'tenant_id = current_setting(\'app.tenant_id\')',
      rawSql: 'DROP POLICY tenant_policy ON users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('Unrecognized key');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects invalid RLS-management option values before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageRLSTool.execute({
      operation: 'create_policy',
      tableName: 'users',
      policyName: 'tenant_policy',
      using: 'true',
      command: 'MERGE'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid input');
    expect(result.content[0].text).toContain('command');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe RLS identifiers before connecting', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageRLSTool.execute({
      operation: 'drop_policy',
      tableName: 'users',
      policyName: 'policy1; drop table users'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects missing RLS operation fields before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageRLSTool.execute({
      operation: 'create_policy',
      tableName: 'users',
      policyName: 'tenant_policy'
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('tableName, policyName, and using are required');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });

  it('rejects unsafe RLS roles before resolving a connection string', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue([]),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);

    const result = await manageRLSTool.execute({
      operation: 'edit_policy',
      tableName: 'users',
      policyName: 'tenant_policy',
      roles: ['authenticated; drop role authenticated']
    }, mockGetConnectionString);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid SQL identifier');
    expect(mockGetConnectionString).not.toHaveBeenCalled();
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.query).not.toHaveBeenCalled();
  });
});
