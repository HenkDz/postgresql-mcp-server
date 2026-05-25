import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  DOCUMENTED_CLI_OPTIONS,
  DOCUMENTED_ENVIRONMENT_VARIABLES,
  DOCUMENTED_TOOLS_CONFIG_KEYS,
  PACKAGE_VERSION,
  PostgreSQLServer,
  allTools,
  createCliProgram,
  createRuntimeConfig,
  main,
  type RuntimeConfig
} from './index';
import type { PostgresTool, ToolOutput } from './types/tool';
import { executeSqlTool } from './tools/data';
import { DatabaseConnection } from './utils/connection';

function runtimeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  return {
    securityPolicy: { mode: 'readonly', allowDestructive: false },
    allowToolConnectionString: false,
    connectionString: 'postgresql://server',
    ...overrides
  };
}

function textOutput(text: string): ToolOutput {
  return {
    content: [{ type: 'text', text }]
  };
}

function createTool(
  name: string,
  execute: PostgresTool['execute']
): PostgresTool {
  return {
    name,
    description: `${name} test tool`,
    inputSchema: z.object({}),
    execute
  };
}

function getAuditEvents(): Array<Record<string, unknown>> {
  return vi.mocked(console.error).mock.calls
    .filter((call) => call[0] === '[MCP Audit]')
    .map((call) => JSON.parse(call[1] as string) as Record<string, unknown>);
}

describe('PostgreSQLServer request boundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('blocks per-tool connection strings before executing the tool', async () => {
    let called = false;
    const tool = createTool('pg_execute_query', async () => {
      called = true;
      return textOutput('should not execute');
    });
    const server = new PostgreSQLServer([tool], runtimeConfig(), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_query', {
      query: 'SELECT 1',
      connectionString: 'postgresql://attacker'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Per-tool connection string arguments are disabled');
    expect(called).toBe(false);
    expect(getAuditEvents()).toEqual([
      expect.objectContaining({
        event: 'postgres_mcp.security',
        outcome: 'denied',
        reason: 'per_tool_connection_string_blocked',
        toolName: 'pg_execute_query',
        securityMode: 'readonly',
        hasToolConnectionString: true
      })
    ]);
  });

  it('passes the configured server-level connection string to allowed tools', async () => {
    const tool = createTool('pg_execute_query', async (args, getConnectionString) => {
      expect(args).toEqual({ query: 'SELECT 1' });
      return textOutput(getConnectionString());
    });
    const server = new PostgreSQLServer([tool], runtimeConfig(), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_query', { query: 'SELECT 1' });

    expect(result).toEqual(textOutput('postgresql://server'));
  });

  it('blocks disallowed server-level connection targets before connecting', async () => {
    const tool = createTool('pg_execute_query', async (_args, getConnectionString) => {
      return textOutput(getConnectionString());
    });
    const server = new PostgreSQLServer([tool], runtimeConfig({
      connectionString: 'postgresql://readonly:secret@other.internal:5432/app',
      allowedConnectionTargets: [{
        source: 'readonly@db.internal:5432/app',
        user: 'readonly',
        host: 'db.internal',
        port: '5432',
        database: 'app'
      }]
    }), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_query', { query: 'SELECT 1' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection target "readonly@other.internal:');
    expect(result.content[0].text).toContain('/app" is not allowed');
    expect(result.content[0].text).not.toContain('secret');
    expect(getAuditEvents()).toEqual([
      expect.objectContaining({
        reason: 'connection_target_denied',
        toolName: 'pg_execute_query',
        hasToolConnectionString: false
      })
    ]);
    expect(JSON.stringify(getAuditEvents())).not.toContain('secret');
  });

  it('blocks disallowed per-tool connection targets before executing the tool', async () => {
    let called = false;
    const tool = createTool('pg_execute_query', async () => {
      called = true;
      return textOutput('should not execute');
    });
    const server = new PostgreSQLServer([tool], runtimeConfig({
      allowToolConnectionString: true,
      allowedConnectionTargets: [{
        source: 'readonly@db.internal:5432/app',
        user: 'readonly',
        host: 'db.internal',
        port: '5432',
        database: 'app'
      }]
    }), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_query', {
      query: 'SELECT 1',
      connectionString: 'postgresql://readonly:secret@other.internal:5432/app'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Connection target "readonly@other.internal:');
    expect(result.content[0].text).toContain('/app" is not allowed');
    expect(result.content[0].text).not.toContain('secret');
    expect(called).toBe(false);
    expect(getAuditEvents()).toEqual([
      expect.objectContaining({
        reason: 'connection_target_denied',
        toolName: 'pg_execute_query',
        hasToolConnectionString: true
      })
    ]);
    expect(JSON.stringify(getAuditEvents())).not.toContain('secret');
  });

  it('allows per-tool source and target connection strings when each target is allowlisted', async () => {
    const tool = createTool('pg_copy_between_databases', async () => textOutput('copy allowed'));
    const server = new PostgreSQLServer([tool], runtimeConfig({
      allowToolConnectionString: true,
      securityPolicy: { mode: 'admin', allowDestructive: true },
      allowedConnectionTargets: [{
        source: '*@db.internal:5432/*',
        user: '*',
        host: 'db.internal',
        port: '5432',
        database: '*'
      }]
    }), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_copy_between_databases', {
      sourceConnectionString: 'postgresql://reader:secret@db.internal:5432/source',
      targetConnectionString: 'postgresql://writer:secret@db.internal:5432/target',
      tableName: 'users'
    });

    expect(result).toEqual(textOutput('copy allowed'));
  });

  it('fails closed when enabledTools names an unavailable tool', () => {
    const tool = createTool('pg_execute_query', async () => textOutput('query allowed'));

    expect(() => new PostgreSQLServer([
      tool
    ], runtimeConfig({
      enabledTools: ['pg_execute_query', 'pg_missing_tool']
    }), { registerSignalHandlers: false })).toThrow('Unknown enabledTools configured: pg_missing_tool');
  });

  it('does not execute available tools omitted from enabledTools', async () => {
    const queryTool = createTool('pg_execute_query', async () => textOutput('query allowed'));
    const mutationTool = createTool('pg_execute_mutation', async () => textOutput('should not execute'));
    const server = new PostgreSQLServer([
      queryTool,
      mutationTool
    ], runtimeConfig({
      enabledTools: ['pg_execute_query'],
      securityPolicy: { mode: 'write', allowDestructive: false }
    }), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_mutation', {
      operation: 'insert',
      tableName: 'users',
      data: { email: 'user@example.com' }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('available but not enabled');
    expect(getAuditEvents()).toEqual([
      expect.objectContaining({
        reason: 'tool_not_enabled',
        toolName: 'pg_execute_mutation',
        availableButDisabled: true
      })
    ]);
  });

  it('lists the hardened schema contract for every runtime tool', () => {
    const server = new PostgreSQLServer(allTools, runtimeConfig(), { registerSignalHandlers: false });

    const result = server.listTools();
    const runtimeToolNames = allTools.map(tool => tool.name);
    const listedToolNames = result.tools.map(tool => tool.name);

    expect(result.tools).toHaveLength(allTools.length);
    expect(listedToolNames).toEqual(runtimeToolNames);

    for (const tool of result.tools) {
      expect(tool.description.length, `${tool.name} description`).toBeGreaterThan(0);
      expect(tool.inputSchema, `${tool.name} input schema`).toMatchObject({
        type: 'object',
        additionalProperties: false
      });
    }
  });

  it('lists only enabled tools when an allow-list is configured', () => {
    const server = new PostgreSQLServer(allTools, runtimeConfig({
      enabledTools: ['pg_execute_query', 'pg_monitor_database']
    }), { registerSignalHandlers: false });

    expect(server.listTools().tools.map(tool => tool.name)).toEqual([
      'pg_execute_query',
      'pg_monitor_database'
    ]);
  });

  it('exposes current pg_execute_sql guardrails in listed JSON schema', () => {
    const server = new PostgreSQLServer(allTools, runtimeConfig(), { registerSignalHandlers: false });

    const executeSqlSchema = server.listTools().tools.find(tool => tool.name === 'pg_execute_sql')?.inputSchema as {
      required?: string[];
      properties?: Record<string, Record<string, unknown>>;
    } | undefined;

    expect(executeSqlSchema).toBeDefined();
    expect(executeSqlSchema?.required).toEqual(['sql']);
    expect(executeSqlSchema?.properties?.maxRows).toMatchObject({
      minimum: 1,
      maximum: 1000,
      default: 100
    });
    expect(executeSqlSchema?.properties?.transactional).toMatchObject({
      type: 'boolean',
      default: false
    });
  });

  it('blocks policy-denied write tools before executing the tool', async () => {
    let called = false;
    const tool = createTool('pg_execute_mutation', async () => {
      called = true;
      return textOutput('should not execute');
    });
    const server = new PostgreSQLServer([tool], runtimeConfig(), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_mutation', {
      operation: 'insert',
      tableName: 'users',
      data: { email: 'user@example.com' }
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Blocked by PostgreSQL MCP security policy');
    expect(called).toBe(false);
    expect(getAuditEvents()).toEqual([
      expect.objectContaining({
        reason: 'security_policy_denied',
        toolName: 'pg_execute_mutation',
        risk: 'write',
        destructive: false
      })
    ]);
  });

  it('allows write tools in write mode', async () => {
    const tool = createTool('pg_execute_mutation', async () => textOutput('mutation allowed'));
    const server = new PostgreSQLServer([
      tool
    ], runtimeConfig({
      securityPolicy: { mode: 'write', allowDestructive: false }
    }), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_mutation', {
      operation: 'insert',
      tableName: 'users',
      data: { email: 'user@example.com' }
    });

    expect(result).toEqual(textOutput('mutation allowed'));
  });

  it('blocks arbitrary SQL before executing the tool when mode is below unsafe', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [{ value: 1 }], rowCount: 1 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);
    const server = new PostgreSQLServer([executeSqlTool], runtimeConfig({
      securityPolicy: { mode: 'admin', allowDestructive: true }
    }), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_sql', {
      sql: 'SELECT 1'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Blocked by PostgreSQL MCP security policy');
    expect(result.content[0].text).toContain('Current mode "admin"');
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.queryResult).not.toHaveBeenCalled();
  });

  it('requires destructive opt-in for arbitrary SQL even in unsafe mode', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [{ value: 1 }], rowCount: 1 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);
    const server = new PostgreSQLServer([executeSqlTool], runtimeConfig({
      securityPolicy: { mode: 'unsafe', allowDestructive: false }
    }), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_sql', {
      sql: 'SELECT 1'
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Destructive operations require allowDestructive=true');
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.queryResult).not.toHaveBeenCalled();
  });

  it('runs arbitrary SQL tool validation before connection resolution once policy allows the call', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      transaction: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);
    const server = new PostgreSQLServer([executeSqlTool], runtimeConfig({
      securityPolicy: { mode: 'unsafe', allowDestructive: true }
    }), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_sql', {
      sql: 'SELECT 1; SELECT 2',
      transactional: true,
      expectRows: true
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('expectRows=false');
    expect(mockDb.connect).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('allows arbitrary SQL through the real tool only in unsafe mode with destructive opt-in', async () => {
    const mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      queryResult: vi.fn().mockResolvedValue({ rows: [{ value: 1 }], rowCount: 1 }),
      disconnect: vi.fn().mockResolvedValue(undefined)
    };
    vi.spyOn(DatabaseConnection, 'getInstance').mockReturnValue(mockDb as unknown as DatabaseConnection);
    const server = new PostgreSQLServer([executeSqlTool], runtimeConfig({
      securityPolicy: { mode: 'unsafe', allowDestructive: true }
    }), { registerSignalHandlers: false });

    const result = await server.handleToolCall('pg_execute_sql', {
      sql: 'SELECT 1 AS value',
      maxRows: 10
    });

    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Retrieved 1 rows');
    expect(result.content[0].text).toContain('"value": 1');
    expect(mockDb.connect).toHaveBeenCalledWith('postgresql://server');
    expect(mockDb.queryResult).toHaveBeenCalledWith('SELECT 1 AS value', [], {});
  });

  it('cleans up server resources only once across repeated close calls', async () => {
    const server = new PostgreSQLServer([], runtimeConfig(), { registerSignalHandlers: false });
    const closeServer = vi.fn().mockResolvedValue(undefined);
    const cleanupPools = vi.spyOn(DatabaseConnection, 'cleanupPools').mockResolvedValue(undefined);

    (server as unknown as { server: { close: () => Promise<void> } }).server = {
      close: closeServer
    };

    await Promise.all([
      server.close(),
      server.close()
    ]);

    expect(cleanupPools).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it('still closes the MCP server when pool cleanup fails', async () => {
    const server = new PostgreSQLServer([], runtimeConfig(), { registerSignalHandlers: false });
    const closeServer = vi.fn().mockResolvedValue(undefined);
    const cleanupPools = vi.spyOn(DatabaseConnection, 'cleanupPools').mockRejectedValue(new Error('pool cleanup failed'));

    (server as unknown as { server: { close: () => Promise<void> } }).server = {
      close: closeServer
    };

    await expect(server.close()).rejects.toThrow('Cleanup failed: pool cleanup failed');

    expect(cleanupPools).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
  });

  it('removes registered signal handlers and exits after signal-triggered cleanup', async () => {
    const registeredHandlers = new Map<string, NodeJS.SignalsListener>();
    const processOn = vi.spyOn(process, 'on').mockImplementation((signal, listener) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        registeredHandlers.set(signal, listener as NodeJS.SignalsListener);
      }
      return process;
    });
    const removeListener = vi.spyOn(process, 'removeListener').mockImplementation(() => process);
    const exitProcess = vi.fn();
    const cleanupPools = vi.spyOn(DatabaseConnection, 'cleanupPools').mockResolvedValue(undefined);
    const closeServer = vi.fn().mockResolvedValue(undefined);

    const server = new PostgreSQLServer([], runtimeConfig(), {
      exitProcess
    });
    (server as unknown as { server: { close: () => Promise<void> } }).server = {
      close: closeServer
    };

    await registeredHandlers.get('SIGTERM')?.('SIGTERM');

    expect(processOn).toHaveBeenCalledWith('SIGINT', expect.any(Function));
    expect(processOn).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith('SIGINT', registeredHandlers.get('SIGINT'));
    expect(removeListener).toHaveBeenCalledWith('SIGTERM', registeredHandlers.get('SIGTERM'));
    expect(cleanupPools).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('exits nonzero when signal-triggered cleanup fails', async () => {
    const registeredHandlers = new Map<string, NodeJS.SignalsListener>();
    vi.spyOn(process, 'on').mockImplementation((signal, listener) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        registeredHandlers.set(signal, listener as NodeJS.SignalsListener);
      }
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);
    const exitProcess = vi.fn();
    const cleanupPools = vi.spyOn(DatabaseConnection, 'cleanupPools').mockRejectedValue(new Error('pool cleanup failed'));
    const closeServer = vi.fn().mockResolvedValue(undefined);

    const server = new PostgreSQLServer([], runtimeConfig(), {
      exitProcess
    });
    (server as unknown as { server: { close: () => Promise<void> } }).server = {
      close: closeServer
    };

    await registeredHandlers.get('SIGINT')?.('SIGINT');

    expect(cleanupPools).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(1);
    expect(vi.mocked(console.error).mock.calls.some((call) =>
      call[0] === 'Error during PostgreSQL MCP server shutdown:' &&
      String(call[1]).includes('pool cleanup failed')
    )).toBe(true);
  });

  it('runs signal-triggered shutdown exit path only once for repeated signals', async () => {
    const registeredHandlers = new Map<string, NodeJS.SignalsListener>();
    vi.spyOn(process, 'on').mockImplementation((signal, listener) => {
      if (signal === 'SIGINT' || signal === 'SIGTERM') {
        registeredHandlers.set(signal, listener as NodeJS.SignalsListener);
      }
      return process;
    });
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);
    const exitProcess = vi.fn();
    const cleanupPools = vi.spyOn(DatabaseConnection, 'cleanupPools').mockResolvedValue(undefined);
    const closeServer = vi.fn().mockResolvedValue(undefined);

    const server = new PostgreSQLServer([], runtimeConfig(), {
      exitProcess
    });
    (server as unknown as { server: { close: () => Promise<void> } }).server = {
      close: closeServer
    };

    await Promise.all([
      registeredHandlers.get('SIGINT')?.('SIGINT'),
      registeredHandlers.get('SIGTERM')?.('SIGTERM')
    ]);

    expect(cleanupPools).toHaveBeenCalledTimes(1);
    expect(closeServer).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledTimes(1);
    expect(exitProcess).toHaveBeenCalledWith(0);
  });

  it('cleans up constructed server resources when main run fails', async () => {
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);
    vi.spyOn(PostgreSQLServer.prototype, 'run').mockRejectedValue(new Error('transport failed'));
    const close = vi.spyOn(PostgreSQLServer.prototype, 'close').mockResolvedValue(undefined);

    await expect(main(['node', 'build/index.js'])).rejects.toThrow('transport failed');

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('preserves the startup failure when cleanup after failed run also fails', async () => {
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.spyOn(process, 'removeListener').mockImplementation(() => process);
    vi.spyOn(PostgreSQLServer.prototype, 'run').mockRejectedValue(new Error('transport failed'));
    vi.spyOn(PostgreSQLServer.prototype, 'close').mockRejectedValue(new Error('cleanup failed'));

    await expect(main(['node', 'build/index.js'])).rejects.toThrow('transport failed');

    expect(vi.mocked(console.error).mock.calls.some((call) =>
      call[0] === 'Error during PostgreSQL MCP server cleanup after failed startup:' &&
      String(call[1]).includes('cleanup failed')
    )).toBe(true);
  });

  it('normalizes runtime config without rewriting valid numeric environment defaults', () => {
    const env: NodeJS.ProcessEnv = {
      POSTGRES_CONNECTION_STRING: 'postgresql://env',
      POSTGRES_MCP_SECURITY_MODE: 'write',
      POSTGRES_MCP_AUDIT_FILE: '/env/audit.jsonl',
      POSTGRES_MCP_MAX_CONNECTIONS: '7',
      POSTGRES_MCP_IDLE_TIMEOUT_MS: '1500',
      POSTGRES_MCP_CONNECTION_TIMEOUT_MS: '2500',
      POSTGRES_MCP_MAX_FILE_BYTES: '1000',
      POSTGRES_MCP_STATEMENT_TIMEOUT_MS: '2000',
      POSTGRES_MCP_LOCK_TIMEOUT_MS: '3500',
      POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: '4500'
    };

    const config = createRuntimeConfig({
      queryTimeoutMs: 2500
    }, env);

    expect(config.securityPolicy.mode).toBe('write');
    expect(env.POSTGRES_MCP_AUDIT_FILE).toBe('/env/audit.jsonl');
    expect(env.POSTGRES_MCP_MAX_CONNECTIONS).toBe('7');
    expect(env.POSTGRES_MCP_IDLE_TIMEOUT_MS).toBe('1500');
    expect(env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS).toBe('2500');
    expect(env.POSTGRES_MCP_MAX_FILE_BYTES).toBe('1000');
    expect(env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS).toBe('2000');
    expect(env.POSTGRES_MCP_QUERY_TIMEOUT_MS).toBe('2500');
    expect(env.POSTGRES_MCP_LOCK_TIMEOUT_MS).toBe('3500');
    expect(env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS).toBe('4500');
  });

  it('keeps runtime option metadata in sync with CLI and main docs', () => {
    const runtimeCliOptions = createCliProgram().options
      .map((option) => option.long)
      .filter(Boolean)
      .sort();

    expect([...DOCUMENTED_CLI_OPTIONS].sort()).toEqual(runtimeCliOptions);

    const readme = readFileSync('README.md', 'utf8');
    const usage = readFileSync('docs/USAGE.md', 'utf8');
    const documentedValues = [
      ...DOCUMENTED_CLI_OPTIONS,
      ...DOCUMENTED_ENVIRONMENT_VARIABLES,
      ...DOCUMENTED_TOOLS_CONFIG_KEYS
    ];

    for (const value of documentedValues) {
      expect(readme, `README.md should document ${value}`).toContain(value);
      expect(usage, `docs/USAGE.md should document ${value}`).toContain(value);
    }
  });

  it('keeps runtime version metadata in sync with package manifests', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as {
      version: string;
      packages?: Record<string, { version?: string }>;
    };

    expect(PACKAGE_VERSION).toBe(packageJson.version);
    expect(PACKAGE_VERSION).toBe(packageLock.version);
    expect(PACKAGE_VERSION).toBe(packageLock.packages?.['']?.version);
    expect(createCliProgram().version()).toBe(PACKAGE_VERSION);
  });

  it('fails closed on invalid explicit CLI numeric resource settings', () => {
    expect(() => createRuntimeConfig({
      maxConnections: '0'
    }, {})).toThrow('--max-connections must be a positive integer');

    expect(() => createRuntimeConfig({
      idleTimeoutMillis: -1
    }, {})).toThrow('--idle-timeout-ms must be a positive integer');

    expect(() => createRuntimeConfig({
      connectionTimeoutMillis: 1.5
    }, {})).toThrow('--connection-timeout-ms must be a positive integer');

    expect(() => createRuntimeConfig({
      maxFileBytes: '0'
    }, {})).toThrow('--max-file-bytes must be a positive integer');

    expect(() => createRuntimeConfig({
      statementTimeoutMs: 'not-a-number'
    }, {})).toThrow('--statement-timeout-ms must be a positive integer');

    expect(() => createRuntimeConfig({
      queryTimeoutMs: -1
    }, {})).toThrow('--query-timeout-ms must be a positive integer');

    expect(() => createRuntimeConfig({
      lockTimeoutMs: 1.5
    }, {})).toThrow('--lock-timeout-ms must be a positive integer');

    expect(() => createRuntimeConfig({
      idleInTransactionSessionTimeoutMs: 0
    }, {})).toThrow('--idle-in-transaction-session-timeout-ms must be a positive integer');
  });

  it('fails closed on invalid numeric environment resource settings', () => {
    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_MAX_CONNECTIONS: '0'
    })).toThrow('POSTGRES_MCP_MAX_CONNECTIONS must be a positive integer');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_IDLE_TIMEOUT_MS: 'nope'
    })).toThrow('POSTGRES_MCP_IDLE_TIMEOUT_MS must be a positive integer');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_CONNECTION_TIMEOUT_MS: '1.5'
    })).toThrow('POSTGRES_MCP_CONNECTION_TIMEOUT_MS must be a positive integer');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_MAX_FILE_BYTES: '0'
    })).toThrow('POSTGRES_MCP_MAX_FILE_BYTES must be a positive integer');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_STATEMENT_TIMEOUT_MS: 'not-a-number'
    })).toThrow('POSTGRES_MCP_STATEMENT_TIMEOUT_MS must be a positive integer');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_QUERY_TIMEOUT_MS: '1.5'
    })).toThrow('POSTGRES_MCP_QUERY_TIMEOUT_MS must be a positive integer');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_LOCK_TIMEOUT_MS: '0'
    })).toThrow('POSTGRES_MCP_LOCK_TIMEOUT_MS must be a positive integer');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: 'NaN'
    })).toThrow('POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS must be a positive integer');
  });

  it('lets CLI numeric values override invalid environment resource settings', () => {
    const env: NodeJS.ProcessEnv = {
      POSTGRES_MCP_MAX_CONNECTIONS: 'invalid',
      POSTGRES_MCP_IDLE_TIMEOUT_MS: 'invalid',
      POSTGRES_MCP_CONNECTION_TIMEOUT_MS: 'invalid',
      POSTGRES_MCP_MAX_FILE_BYTES: 'invalid',
      POSTGRES_MCP_STATEMENT_TIMEOUT_MS: 'invalid',
      POSTGRES_MCP_QUERY_TIMEOUT_MS: 'invalid',
      POSTGRES_MCP_LOCK_TIMEOUT_MS: 'invalid',
      POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: 'invalid'
    };

    createRuntimeConfig({
      maxConnections: '10',
      idleTimeoutMillis: '11000',
      connectionTimeoutMillis: '12000',
      maxFileBytes: '1000',
      statementTimeoutMs: '2000',
      queryTimeoutMs: '3000',
      lockTimeoutMs: '4000',
      idleInTransactionSessionTimeoutMs: '5000'
    }, env);

    expect(env.POSTGRES_MCP_MAX_CONNECTIONS).toBe('10');
    expect(env.POSTGRES_MCP_IDLE_TIMEOUT_MS).toBe('11000');
    expect(env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS).toBe('12000');
    expect(env.POSTGRES_MCP_MAX_FILE_BYTES).toBe('1000');
    expect(env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS).toBe('2000');
    expect(env.POSTGRES_MCP_QUERY_TIMEOUT_MS).toBe('3000');
    expect(env.POSTGRES_MCP_LOCK_TIMEOUT_MS).toBe('4000');
    expect(env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS).toBe('5000');
  });

  it('fails closed on invalid explicit security modes', () => {
    expect(() => createRuntimeConfig({
      securityMode: 'readwrite'
    }, {})).toThrow('securityMode must be one of readonly, write, admin, or unsafe');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_SECURITY_MODE: 'owner'
    })).toThrow('securityMode must be one of readonly, write, admin, or unsafe');

    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      securityMode: 'superuser'
    }));

    try {
      expect(() => createRuntimeConfig({
        toolsConfig: configPath
      }, {})).toThrow('securityMode must be one of readonly, write, admin, or unsafe');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lets explicit false config booleans override enabling environment variables', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      allowDestructive: false,
      allowToolConnectionString: false
    }));

    try {
      const config = createRuntimeConfig({
        toolsConfig: configPath
      }, {
        POSTGRES_MCP_ALLOW_DESTRUCTIVE: 'true',
        POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING: 'true'
      });

      expect(config.securityPolicy.allowDestructive).toBe(false);
      expect(config.allowToolConnectionString).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed on invalid boolean environment flags', () => {
    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_ALLOW_DESTRUCTIVE: 'yes'
    })).toThrow('POSTGRES_MCP_ALLOW_DESTRUCTIVE must be "true" or "false"');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING: '1'
    })).toThrow('POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING must be "true" or "false"');
  });

  it('accepts explicit false boolean environment flags', () => {
    const config = createRuntimeConfig({}, {
      POSTGRES_MCP_ALLOW_DESTRUCTIVE: 'false',
      POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING: 'false'
    });

    expect(config.securityPolicy.allowDestructive).toBe(false);
    expect(config.allowToolConnectionString).toBe(false);
  });

  it('fails closed on explicit empty startup connection string values', () => {
    expect(() => createRuntimeConfig({
      connectionString: ''
    }, {
      POSTGRES_CONNECTION_STRING: 'postgresql://env'
    })).toThrow('--connection-string must be a non-empty string');

    expect(() => createRuntimeConfig({
      connectionString: '   '
    }, {
      POSTGRES_CONNECTION_STRING: 'postgresql://env'
    })).toThrow('--connection-string must be a non-empty string');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_CONNECTION_STRING: ''
    })).toThrow('POSTGRES_CONNECTION_STRING must be a non-empty string');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_CONNECTION_STRING: '\t '
    })).toThrow('POSTGRES_CONNECTION_STRING must be a non-empty string');
  });

  it('lets a valid CLI connection string override a blank environment connection string', () => {
    const config = createRuntimeConfig({
      connectionString: 'postgresql://cli'
    }, {
      POSTGRES_CONNECTION_STRING: '   '
    });

    expect(config.connectionString).toBe('postgresql://cli');
  });

  it('loads allowed connection targets from CLI, config, and environment with precedence', () => {
    const cliConfig = createRuntimeConfig({
      connectionString: 'postgresql://readonly@cli.internal:5432/app',
      allowedConnectionTarget: ['readonly@cli.internal:5432/app']
    }, {
      POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS: 'readonly@env.internal:5432/app'
    });
    expect(cliConfig.allowedConnectionTargets?.map(target => target.source)).toEqual([
      'readonly@cli.internal:5432/app'
    ]);

    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      allowedConnectionTargets: ['readonly@config.internal:5432/app']
    }));

    try {
      const fileConfig = createRuntimeConfig({
        toolsConfig: configPath
      }, {
        POSTGRES_CONNECTION_STRING: 'postgresql://readonly@config.internal:5432/app',
        POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS: 'readonly@env.internal:5432/app'
      });
      expect(fileConfig.allowedConnectionTargets?.map(target => target.source)).toEqual([
        'readonly@config.internal:5432/app'
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }

    const envConfig = createRuntimeConfig({}, {
      POSTGRES_CONNECTION_STRING: 'postgresql://readonly@env.internal:5432/app',
      POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS: 'readonly@env.internal:5432/app'
    });
    expect(envConfig.allowedConnectionTargets?.map(target => target.source)).toEqual([
      'readonly@env.internal:5432/app'
    ]);
  });

  it('fails startup when the configured connection string is outside the allowlist', () => {
    expect(() => createRuntimeConfig({
      connectionString: 'postgresql://readonly:secret@other.internal:5432/app',
      allowedConnectionTarget: ['readonly@db.internal:5432/app']
    }, {})).toThrow('Connection target "readonly@other.internal:5432/app" is not allowed');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_CONNECTION_STRING: 'postgresql://readonly:secret@other.internal:5432/app',
      POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS: 'readonly@db.internal:5432/app'
    })).toThrow('Connection target "readonly@other.internal:5432/app" is not allowed');
  });

  it('fails closed on invalid allowed connection target configuration', () => {
    expect(() => createRuntimeConfig({
      allowedConnectionTarget: ['db.*.internal/app']
    }, {})).toThrow('full-field wildcard');

    expect(() => createRuntimeConfig({}, {
      POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS: 'db.internal,,localhost'
    })).toThrow('must not contain empty entries');

    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      allowedConnectionTargets: 'db.internal'
    }));

    try {
      expect(() => createRuntimeConfig({
        toolsConfig: configPath
      }, {})).toThrow('allowedConnectionTargets must be an array');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('lets CLI boolean flags override safer config defaults', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      allowDestructive: false,
      allowToolConnectionString: false
    }));

    try {
      const config = createRuntimeConfig({
        toolsConfig: configPath,
        allowDestructive: true,
        allowToolConnectionString: true
      }, {});

      expect(config.securityPolicy.allowDestructive).toBe(true);
      expect(config.allowToolConnectionString).toBe(true);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('applies CLI numeric and workspace options over config and environment values', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      workspaceDir: '/config-workspace',
      maxConnections: 2,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 1500,
      maxFileBytes: 2000,
      statementTimeoutMs: 3000,
      queryTimeoutMs: 4000,
      lockTimeoutMs: 5000,
      idleInTransactionSessionTimeoutMs: 6000
    }));

    try {
      const env: NodeJS.ProcessEnv = {
        POSTGRES_MCP_WORKSPACE_DIR: '/env-workspace',
        POSTGRES_MCP_MAX_CONNECTIONS: '3',
        POSTGRES_MCP_IDLE_TIMEOUT_MS: '4',
        POSTGRES_MCP_CONNECTION_TIMEOUT_MS: '5',
        POSTGRES_MCP_MAX_FILE_BYTES: '20',
        POSTGRES_MCP_STATEMENT_TIMEOUT_MS: '30',
        POSTGRES_MCP_QUERY_TIMEOUT_MS: '40',
        POSTGRES_MCP_LOCK_TIMEOUT_MS: '50',
        POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: '60'
      };

      createRuntimeConfig({
        toolsConfig: configPath,
        workspaceDir: '/cli-workspace',
        maxConnections: '11',
        idleTimeoutMillis: '12',
        connectionTimeoutMillis: '13',
        maxFileBytes: '5000',
        statementTimeoutMs: '6000',
        queryTimeoutMs: '7000',
        lockTimeoutMs: '8000',
        idleInTransactionSessionTimeoutMs: '9000'
      }, env);

      expect(env.POSTGRES_MCP_WORKSPACE_DIR).toBe('/cli-workspace');
      expect(env.POSTGRES_MCP_MAX_CONNECTIONS).toBe('11');
      expect(env.POSTGRES_MCP_IDLE_TIMEOUT_MS).toBe('12');
      expect(env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS).toBe('13');
      expect(env.POSTGRES_MCP_MAX_FILE_BYTES).toBe('5000');
      expect(env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS).toBe('6000');
      expect(env.POSTGRES_MCP_QUERY_TIMEOUT_MS).toBe('7000');
      expect(env.POSTGRES_MCP_LOCK_TIMEOUT_MS).toBe('8000');
      expect(env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS).toBe('9000');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('applies config numeric and workspace values over environment defaults', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      workspaceDir: '/config-workspace',
      maxConnections: 2,
      idleTimeoutMillis: 1000,
      connectionTimeoutMillis: 1500,
      maxFileBytes: 2000,
      statementTimeoutMs: 3000,
      queryTimeoutMs: 4000,
      lockTimeoutMs: 5000,
      idleInTransactionSessionTimeoutMs: 6000
    }));

    try {
      const env: NodeJS.ProcessEnv = {
        POSTGRES_MCP_WORKSPACE_DIR: '/env-workspace',
        POSTGRES_MCP_MAX_CONNECTIONS: '3',
        POSTGRES_MCP_IDLE_TIMEOUT_MS: '4',
        POSTGRES_MCP_CONNECTION_TIMEOUT_MS: '5',
        POSTGRES_MCP_MAX_FILE_BYTES: '20',
        POSTGRES_MCP_STATEMENT_TIMEOUT_MS: '30',
        POSTGRES_MCP_QUERY_TIMEOUT_MS: '40',
        POSTGRES_MCP_LOCK_TIMEOUT_MS: '50',
        POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS: '60'
      };

      createRuntimeConfig({
        toolsConfig: configPath
      }, env);

      expect(env.POSTGRES_MCP_WORKSPACE_DIR).toBe('/config-workspace');
      expect(env.POSTGRES_MCP_MAX_CONNECTIONS).toBe('2');
      expect(env.POSTGRES_MCP_IDLE_TIMEOUT_MS).toBe('1000');
      expect(env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS).toBe('1500');
      expect(env.POSTGRES_MCP_MAX_FILE_BYTES).toBe('2000');
      expect(env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS).toBe('3000');
      expect(env.POSTGRES_MCP_QUERY_TIMEOUT_MS).toBe('4000');
      expect(env.POSTGRES_MCP_LOCK_TIMEOUT_MS).toBe('5000');
      expect(env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS).toBe('6000');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed on explicit empty workspace directory values', () => {
    expect(() => createRuntimeConfig({
      workspaceDir: ''
    }, {})).toThrow('--workspace-dir must be a non-empty string');

    expect(() => createRuntimeConfig({
      workspaceDir: '   '
    }, {})).toThrow('--workspace-dir must be a non-empty string');

    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      workspaceDir: ''
    }));

    try {
      expect(() => createRuntimeConfig({
        toolsConfig: configPath
      }, {})).toThrow('workspaceDir must be a non-empty string');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed on explicit empty audit file values', () => {
    expect(() => createRuntimeConfig({
      auditFile: ''
    }, {})).toThrow('--audit-file must be a non-empty string');

    expect(() => createRuntimeConfig({
      auditFile: '   '
    }, {})).toThrow('--audit-file must be a non-empty string');

    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      auditFile: ''
    }));

    try {
      expect(() => createRuntimeConfig({
        toolsConfig: configPath
      }, {})).toThrow('auditFile must be a non-empty string');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when an explicit tools config path cannot be loaded', () => {
    expect(() => createRuntimeConfig({
      toolsConfig: join(tmpdir(), 'missing-postgres-mcp-tools.json')
    }, {})).toThrow('Failed to load tools configuration file');
  });

  it('fails closed when tools config JSON is malformed', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, '{"enabledTools": [');

    try {
      expect(() => createRuntimeConfig({
        toolsConfig: configPath
      }, {})).toThrow('Failed to load tools configuration file');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when tools config is not a JSON object', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify(['pg_execute_query']));

    try {
      expect(() => createRuntimeConfig({
        toolsConfig: configPath
      }, {})).toThrow('tools config must be a JSON object');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when tools config contains unknown keys', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      enabledTools: ['pg_execute_query'],
      securitymode: 'unsafe',
      allowDropEverything: true
    }));

    try {
      expect(() => createRuntimeConfig({
        toolsConfig: configPath
      }, {})).toThrow('Unknown tools config key(s): securitymode, allowDropEverything');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when tools config fields have invalid types', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      enabledTools: 'pg_execute_query',
      maxFileBytes: 0
    }));

    try {
      expect(() => createRuntimeConfig({
        toolsConfig: configPath
      }, {})).toThrow('enabledTools must be an array');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('applies CLI and config audit file values over environment defaults', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-config-'));
    const configPath = join(tempDir, 'tools.json');
    writeFileSync(configPath, JSON.stringify({
      auditFile: '/config/audit.jsonl'
    }));

    try {
      const cliEnv: NodeJS.ProcessEnv = {
        POSTGRES_MCP_AUDIT_FILE: '/env/audit.jsonl'
      };

      createRuntimeConfig({
        toolsConfig: configPath,
        auditFile: '/cli/audit.jsonl'
      }, cliEnv);

      expect(cliEnv.POSTGRES_MCP_AUDIT_FILE).toBe('/cli/audit.jsonl');

      const configEnv: NodeJS.ProcessEnv = {
        POSTGRES_MCP_AUDIT_FILE: '/env/audit.jsonl'
      };

      createRuntimeConfig({
        toolsConfig: configPath
      }, configEnv);

      expect(configEnv.POSTGRES_MCP_AUDIT_FILE).toBe('/config/audit.jsonl');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
