#!/usr/bin/env node
import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

// Import tool types
import type { PostgresTool, ToolOutput } from './types/tool.js';
import { emitAuditEvent, isConnectionTargetDenial } from './server/audit.js';
import { getToolSuppliedConnectionStrings, hasToolSuppliedConnectionString, resolveConnectionString } from './server/boundary.js';
import {
  assertConnectionTargetAllowed,
  normalizeAllowedConnectionTargets,
  parseAllowedConnectionTargetList,
  type AllowedConnectionTarget
} from './server/connection-target.js';
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DatabaseConnection,
  sanitizeErrorMessage
} from './utils/connection.js';
import {
  classifyToolCall,
  explainPolicyDenial,
  isToolCallAllowed,
  normalizeSecurityMode,
  type SecurityPolicy
} from './security/policy.js';

// Import all tool implementations
import { analyzeDatabaseTool } from './tools/analyze.js';
import { manageFunctionsTool, manageRLSTool } from './tools/functions.js';
import { debugDatabaseTool } from './tools/debug.js';
import { exportTableDataTool, importTableDataTool, copyBetweenDatabasesTool } from './tools/migration.js';
import { monitorDatabaseTool } from './tools/monitor.js';
import { manageSchemaTools } from './tools/schema.js';
import { manageTriggersTools } from './tools/triggers.js';
import { manageIndexesTool } from './tools/indexes.js';
import { manageQueryTool } from './tools/query.js';
import { manageUsersTool } from './tools/users.js';
import { manageConstraintsTool } from './tools/constraints.js';
import { executeQueryTool, executeMutationTool, executeSqlTool } from './tools/data.js';
import { manageCommentsTool } from './tools/comments.js';

export {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS
};

export interface CliOptions {
  connectionString?: string;
  toolsConfig?: string;
  securityMode?: string;
  allowDestructive?: boolean;
  allowToolConnectionString?: boolean;
  workspaceDir?: string;
  auditFile?: string;
  maxConnections?: string | number;
  idleTimeoutMillis?: string | number;
  connectionTimeoutMillis?: string | number;
  maxFileBytes?: string | number;
  statementTimeoutMs?: string | number;
  queryTimeoutMs?: string | number;
  lockTimeoutMs?: string | number;
  idleInTransactionSessionTimeoutMs?: string | number;
  allowedConnectionTarget?: string[];
}

export interface ToolsConfigFile {
  enabledTools?: string[];
  securityMode?: string;
  allowDestructive?: boolean;
  allowToolConnectionString?: boolean;
  workspaceDir?: string;
  auditFile?: string;
  maxConnections?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
  maxFileBytes?: number;
  statementTimeoutMs?: number;
  queryTimeoutMs?: number;
  lockTimeoutMs?: number;
  idleInTransactionSessionTimeoutMs?: number;
  allowedConnectionTargets?: string[];
}

export interface RuntimeConfig {
  enabledTools?: string[];
  securityPolicy: SecurityPolicy;
  allowToolConnectionString: boolean;
  connectionString?: string;
  allowedConnectionTargets?: AllowedConnectionTarget[];
  toolsConfigPath?: string;
}

export interface PostgreSQLServerOptions {
  registerSignalHandlers?: boolean;
  exitProcess?: (code: number) => void;
}

export interface ToolInputJsonSchema {
  type: 'object';
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ListedTool {
  name: string;
  description: string;
  inputSchema: ToolInputJsonSchema;
  [key: string]: unknown;
}

export interface ListToolsResult {
  tools: ListedTool[];
  [key: string]: unknown;
}

export const DOCUMENTED_CLI_OPTIONS = [
  '--version',
  '--connection-string',
  '--tools-config',
  '--security-mode',
  '--allow-destructive',
  '--allow-tool-connection-string',
  '--workspace-dir',
  '--audit-file',
  '--max-connections',
  '--idle-timeout-ms',
  '--connection-timeout-ms',
  '--max-file-bytes',
  '--statement-timeout-ms',
  '--query-timeout-ms',
  '--lock-timeout-ms',
  '--idle-in-transaction-session-timeout-ms',
  '--allowed-connection-target'
] as const;

export const DOCUMENTED_ENVIRONMENT_VARIABLES = [
  'POSTGRES_CONNECTION_STRING',
  'POSTGRES_TOOLS_CONFIG',
  'POSTGRES_MCP_SECURITY_MODE',
  'POSTGRES_MCP_ALLOW_DESTRUCTIVE',
  'POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING',
  'POSTGRES_MCP_WORKSPACE_DIR',
  'POSTGRES_MCP_AUDIT_FILE',
  'POSTGRES_MCP_MAX_CONNECTIONS',
  'POSTGRES_MCP_IDLE_TIMEOUT_MS',
  'POSTGRES_MCP_CONNECTION_TIMEOUT_MS',
  'POSTGRES_MCP_MAX_FILE_BYTES',
  'POSTGRES_MCP_STATEMENT_TIMEOUT_MS',
  'POSTGRES_MCP_QUERY_TIMEOUT_MS',
  'POSTGRES_MCP_LOCK_TIMEOUT_MS',
  'POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS',
  'POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS',
  'POSTGRES_MCP_DEBUG_SQL'
] as const;

export const DOCUMENTED_TOOLS_CONFIG_KEYS = [
  'enabledTools',
  'securityMode',
  'allowDestructive',
  'allowToolConnectionString',
  'workspaceDir',
  'auditFile',
  'maxConnections',
  'idleTimeoutMillis',
  'connectionTimeoutMillis',
  'maxFileBytes',
  'statementTimeoutMs',
  'queryTimeoutMs',
  'lockTimeoutMs',
  'idleInTransactionSessionTimeoutMs',
  'allowedConnectionTargets'
] as const;

const ALLOWED_TOOLS_CONFIG_KEYS = new Set<string>(DOCUMENTED_TOOLS_CONFIG_KEYS);

export const PACKAGE_VERSION = '1.0.6';

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function parsePositiveInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return undefined;
  }

  return parsed;
}

export function createCliProgram(): Command {
  return new Command()
    .version(PACKAGE_VERSION)
    .option('-cs, --connection-string <string>', 'PostgreSQL connection string')
    .option('-tc, --tools-config <path>', 'Path to tools configuration JSON file')
    .option('--security-mode <mode>', 'Security mode: readonly, write, admin, or unsafe')
    .option('--allow-destructive', 'Allow destructive operations such as drops, resets, and arbitrary SQL')
    .option('--allow-tool-connection-string', 'Allow per-tool connection string arguments')
    .option('--workspace-dir <path>', 'Workspace directory for filesystem import/export tools')
    .option('--audit-file <path>', 'Optional JSONL file for sanitized security audit events')
    .option('--max-connections <number>', 'Maximum PostgreSQL pool connections')
    .option('--idle-timeout-ms <number>', 'PostgreSQL pool idle client timeout in milliseconds')
    .option('--connection-timeout-ms <number>', 'PostgreSQL connection acquisition timeout in milliseconds')
    .option('--max-file-bytes <number>', 'Maximum JSON/CSV import/export file size in bytes')
    .option('--statement-timeout-ms <number>', 'Default PostgreSQL statement_timeout in milliseconds')
    .option('--query-timeout-ms <number>', 'Default node-postgres query timeout in milliseconds')
    .option('--lock-timeout-ms <number>', 'Default PostgreSQL lock_timeout in milliseconds')
    .option('--idle-in-transaction-session-timeout-ms <number>', 'Default PostgreSQL idle_in_transaction_session_timeout in milliseconds')
    .option(
      '--allowed-connection-target <target>',
      'Allowed connection target as [user@]host[:port][/database]; repeat to allow multiple targets',
      (value: string, previous: string[] | undefined) => [...(previous ?? []), value]
    );
}

export function parseCliOptions(argv = process.argv): CliOptions {
  const cliProgram = createCliProgram();
  cliProgram.parse(argv);
  return cliProgram.opts<CliOptions>();
}

export function readToolsConfigFile(configPath?: string): ToolsConfigFile {
  if (!configPath) {
    return {};
  }

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const parsedJson = JSON.parse(configContent) as unknown;
    if (!parsedJson || typeof parsedJson !== 'object' || Array.isArray(parsedJson)) {
      throw new Error('tools config must be a JSON object.');
    }

    const parsed = parsedJson as Record<string, unknown>;
    const unknownKeys = Object.keys(parsed).filter((key) => !ALLOWED_TOOLS_CONFIG_KEYS.has(key));
    if (unknownKeys.length > 0) {
      throw new Error(`Unknown tools config key(s): ${unknownKeys.join(', ')}. Allowed keys: ${DOCUMENTED_TOOLS_CONFIG_KEYS.join(', ')}.`);
    }

    const config: ToolsConfigFile = {};

    if ('enabledTools' in parsed) {
      if (!isStringArray(parsed.enabledTools)) {
        throw new Error('enabledTools must be an array of tool names.');
      }
      config.enabledTools = parsed.enabledTools;
    }

    if ('securityMode' in parsed && typeof parsed.securityMode !== 'string') {
      throw new Error('securityMode must be a string.');
    } else if (typeof parsed.securityMode === 'string') {
      config.securityMode = parsed.securityMode;
    }

    if ('allowDestructive' in parsed && typeof parsed.allowDestructive !== 'boolean') {
      throw new Error('allowDestructive must be a boolean.');
    } else if (typeof parsed.allowDestructive === 'boolean') {
      config.allowDestructive = parsed.allowDestructive;
    }

    if ('allowToolConnectionString' in parsed && typeof parsed.allowToolConnectionString !== 'boolean') {
      throw new Error('allowToolConnectionString must be a boolean.');
    } else if (typeof parsed.allowToolConnectionString === 'boolean') {
      config.allowToolConnectionString = parsed.allowToolConnectionString;
    }

    if ('workspaceDir' in parsed && typeof parsed.workspaceDir !== 'string') {
      throw new Error('workspaceDir must be a string.');
    } else if (typeof parsed.workspaceDir === 'string') {
      if (parsed.workspaceDir.trim() === '') {
        throw new Error('workspaceDir must be a non-empty string.');
      }
      config.workspaceDir = parsed.workspaceDir;
    }

    if ('auditFile' in parsed && typeof parsed.auditFile !== 'string') {
      throw new Error('auditFile must be a string.');
    } else if (typeof parsed.auditFile === 'string') {
      if (parsed.auditFile.trim() === '') {
        throw new Error('auditFile must be a non-empty string.');
      }
      config.auditFile = parsed.auditFile;
    }

    if ('maxConnections' in parsed) {
      const maxConnections = parsePositiveInteger(parsed.maxConnections);
      if (maxConnections === undefined) {
        throw new Error('maxConnections must be a positive integer.');
      }
      config.maxConnections = maxConnections;
    }

    if ('idleTimeoutMillis' in parsed) {
      const idleTimeoutMillis = parsePositiveInteger(parsed.idleTimeoutMillis);
      if (idleTimeoutMillis === undefined) {
        throw new Error('idleTimeoutMillis must be a positive integer.');
      }
      config.idleTimeoutMillis = idleTimeoutMillis;
    }

    if ('connectionTimeoutMillis' in parsed) {
      const connectionTimeoutMillis = parsePositiveInteger(parsed.connectionTimeoutMillis);
      if (connectionTimeoutMillis === undefined) {
        throw new Error('connectionTimeoutMillis must be a positive integer.');
      }
      config.connectionTimeoutMillis = connectionTimeoutMillis;
    }

    if ('maxFileBytes' in parsed) {
      const maxFileBytes = parsePositiveInteger(parsed.maxFileBytes);
      if (maxFileBytes === undefined) {
        throw new Error('maxFileBytes must be a positive integer.');
      }
      config.maxFileBytes = maxFileBytes;
    }

    if ('statementTimeoutMs' in parsed) {
      const statementTimeoutMs = parsePositiveInteger(parsed.statementTimeoutMs);
      if (statementTimeoutMs === undefined) {
        throw new Error('statementTimeoutMs must be a positive integer.');
      }
      config.statementTimeoutMs = statementTimeoutMs;
    }

    if ('queryTimeoutMs' in parsed) {
      const queryTimeoutMs = parsePositiveInteger(parsed.queryTimeoutMs);
      if (queryTimeoutMs === undefined) {
        throw new Error('queryTimeoutMs must be a positive integer.');
      }
      config.queryTimeoutMs = queryTimeoutMs;
    }

    if ('lockTimeoutMs' in parsed) {
      const lockTimeoutMs = parsePositiveInteger(parsed.lockTimeoutMs);
      if (lockTimeoutMs === undefined) {
        throw new Error('lockTimeoutMs must be a positive integer.');
      }
      config.lockTimeoutMs = lockTimeoutMs;
    }

    if ('idleInTransactionSessionTimeoutMs' in parsed) {
      const idleInTransactionSessionTimeoutMs = parsePositiveInteger(parsed.idleInTransactionSessionTimeoutMs);
      if (idleInTransactionSessionTimeoutMs === undefined) {
        throw new Error('idleInTransactionSessionTimeoutMs must be a positive integer.');
      }
      config.idleInTransactionSessionTimeoutMs = idleInTransactionSessionTimeoutMs;
    }

    if ('allowedConnectionTargets' in parsed) {
      if (!isStringArray(parsed.allowedConnectionTargets)) {
        throw new Error('allowedConnectionTargets must be an array of connection target patterns.');
      }
      config.allowedConnectionTargets = parsed.allowedConnectionTargets;
    }

    console.error(`[MCP Info] Loaded tools configuration from ${configPath}.`);
    return config;
  } catch (error) {
    throw new Error(`Failed to load tools configuration file at ${configPath}: ${sanitizeErrorMessage(error)}`);
  }
}

function setPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  optionName: string,
  cliValue: string | number | undefined,
  configValue: number | undefined
): void {
  const resolvedValue = resolvePositiveIntegerOption(optionName, cliValue, configValue);

  if (resolvedValue !== undefined) {
    env[key] = String(resolvedValue);
    return;
  }

  if (env[key] !== undefined && env[key] !== '') {
    const parsedEnvValue = parsePositiveInteger(env[key]);
    if (parsedEnvValue === undefined) {
      throw new Error(`${key} must be a positive integer.`);
    }
  }
}

function resolvePositiveIntegerOption(
  optionName: string,
  cliValue: string | number | undefined,
  configValue: number | undefined
): number | undefined {
  if (cliValue !== undefined) {
    const parsedCliValue = parsePositiveInteger(cliValue);
    if (parsedCliValue === undefined) {
      throw new Error(`${optionName} must be a positive integer.`);
    }
    return parsedCliValue;
  }

  return configValue;
}

function resolveBooleanOption(
  optionName: string,
  cliValue: boolean | undefined,
  configValue: boolean | undefined,
  envValue: string | undefined
): boolean {
  if (cliValue !== undefined) {
    return cliValue;
  }

  if (configValue !== undefined) {
    return configValue;
  }

  if (envValue === undefined || envValue === '') {
    return false;
  }

  if (envValue === 'true') {
    return true;
  }

  if (envValue === 'false') {
    return false;
  }

  throw new Error(`${optionName} must be "true" or "false".`);
}

function validateRuntimeConnectionString(optionName: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value.trim() === '') {
    throw new Error(`${optionName} must be a non-empty string.`);
  }

  return value;
}

function resolveAllowedConnectionTargets(
  options: CliOptions,
  configFile: ToolsConfigFile,
  env: NodeJS.ProcessEnv
): AllowedConnectionTarget[] | undefined {
  const targetPatterns = options.allowedConnectionTarget !== undefined
    ? options.allowedConnectionTarget
    : configFile.allowedConnectionTargets !== undefined
      ? configFile.allowedConnectionTargets
      : parseAllowedConnectionTargetList(env.POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS);

  return normalizeAllowedConnectionTargets(targetPatterns);
}

export function createRuntimeConfig(
  options: CliOptions = {},
  env: NodeJS.ProcessEnv = process.env
): RuntimeConfig {
  const toolsConfigPath = options.toolsConfig || env.POSTGRES_TOOLS_CONFIG;
  const configFile = readToolsConfigFile(toolsConfigPath);
  const connectionString = validateRuntimeConnectionString('--connection-string', options.connectionString);
  if (connectionString === undefined) {
    validateRuntimeConnectionString('POSTGRES_CONNECTION_STRING', env.POSTGRES_CONNECTION_STRING);
  }
  const allowedConnectionTargets = resolveAllowedConnectionTargets(options, configFile, env);
  const startupConnectionString = connectionString ?? env.POSTGRES_CONNECTION_STRING;
  if (startupConnectionString !== undefined && startupConnectionString.trim() !== '') {
    assertConnectionTargetAllowed(startupConnectionString, allowedConnectionTargets);
  }

  if (options.workspaceDir !== undefined && options.workspaceDir.trim() === '') {
    throw new Error('--workspace-dir must be a non-empty string.');
  }

  const workspaceDir = options.workspaceDir ?? configFile.workspaceDir;
  if (workspaceDir !== undefined) {
    env.POSTGRES_MCP_WORKSPACE_DIR = workspaceDir;
  }

  if (options.auditFile !== undefined && options.auditFile.trim() === '') {
    throw new Error('--audit-file must be a non-empty string.');
  }

  const auditFile = options.auditFile ?? configFile.auditFile;
  if (auditFile !== undefined) {
    env.POSTGRES_MCP_AUDIT_FILE = auditFile;
  }

  setPositiveIntegerEnv(env, 'POSTGRES_MCP_MAX_CONNECTIONS', '--max-connections', options.maxConnections, configFile.maxConnections);
  setPositiveIntegerEnv(env, 'POSTGRES_MCP_IDLE_TIMEOUT_MS', '--idle-timeout-ms', options.idleTimeoutMillis, configFile.idleTimeoutMillis);
  setPositiveIntegerEnv(env, 'POSTGRES_MCP_CONNECTION_TIMEOUT_MS', '--connection-timeout-ms', options.connectionTimeoutMillis, configFile.connectionTimeoutMillis);
  setPositiveIntegerEnv(env, 'POSTGRES_MCP_MAX_FILE_BYTES', '--max-file-bytes', options.maxFileBytes, configFile.maxFileBytes);
  setPositiveIntegerEnv(env, 'POSTGRES_MCP_STATEMENT_TIMEOUT_MS', '--statement-timeout-ms', options.statementTimeoutMs, configFile.statementTimeoutMs);
  setPositiveIntegerEnv(env, 'POSTGRES_MCP_QUERY_TIMEOUT_MS', '--query-timeout-ms', options.queryTimeoutMs, configFile.queryTimeoutMs);
  setPositiveIntegerEnv(env, 'POSTGRES_MCP_LOCK_TIMEOUT_MS', '--lock-timeout-ms', options.lockTimeoutMs, configFile.lockTimeoutMs);
  setPositiveIntegerEnv(env, 'POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS', '--idle-in-transaction-session-timeout-ms', options.idleInTransactionSessionTimeoutMs, configFile.idleInTransactionSessionTimeoutMs);

  return {
    enabledTools: configFile.enabledTools,
    securityPolicy: {
      mode: normalizeSecurityMode(options.securityMode || configFile.securityMode || env.POSTGRES_MCP_SECURITY_MODE),
      allowDestructive: resolveBooleanOption(
        'POSTGRES_MCP_ALLOW_DESTRUCTIVE',
        options.allowDestructive,
        configFile.allowDestructive,
        env.POSTGRES_MCP_ALLOW_DESTRUCTIVE
      )
    },
    allowToolConnectionString: resolveBooleanOption(
      'POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING',
      options.allowToolConnectionString,
      configFile.allowToolConnectionString,
      env.POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING
    ),
    connectionString,
    allowedConnectionTargets,
    toolsConfigPath
  };
}

export class PostgreSQLServer {
  private server: Server;
  public availableToolsList: PostgresTool[];
  private enabledTools: PostgresTool[];
  private enabledToolsMap: Record<string, PostgresTool>;
  private securityPolicy: SecurityPolicy;
  private allowToolConnectionString: boolean;
  private runtimeConfig: RuntimeConfig;
  private cleanupPromise: Promise<void> | null = null;
  private signalShutdownPromise: Promise<void> | null = null;
  private signalHandlers: Array<{ signal: NodeJS.Signals; handler: NodeJS.SignalsListener }> = [];
  private exitProcess: (code: number) => void;

  private static toolMetadata(tool: PostgresTool): ListedTool {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema) as ToolInputJsonSchema,
    };
  }

  constructor(
    initialTools: PostgresTool[] = [],
    runtimeConfig: RuntimeConfig = createRuntimeConfig(),
    serverOptions: PostgreSQLServerOptions = {}
  ) {
    this.availableToolsList = [...initialTools]; 
    this.enabledTools = [];
    this.enabledToolsMap = {};
    this.securityPolicy = runtimeConfig.securityPolicy;
    this.allowToolConnectionString = runtimeConfig.allowToolConnectionString;
    this.runtimeConfig = runtimeConfig;
    this.exitProcess = serverOptions.exitProcess ?? ((code: number) => process.exit(code));
    this.loadAndFilterTools();

    this.server = new Server(
      {
        name: 'postgresql-mcp-server',
        version: PACKAGE_VERSION,
      },
      {
        capabilities: {
          tools: this.enabledTools.reduce((acc, tool) => {
            acc[tool.name] = PostgreSQLServer.toolMetadata(tool);
            return acc;
          }, {} as Record<string, ListedTool>),
        },
      }
    );
    
    this.setupToolHandlers();
    this.server.onerror = (error) => console.error('[MCP Error]', sanitizeErrorMessage(error));
    
    if (serverOptions.registerSignalHandlers !== false) {
      this.registerSignalHandlers();
    }
  }

  /**
   * Get connection string from various sources in order of precedence:
   * 1. Function argument (internal use after request policy checks)
   * 2. CLI --connection-string option
   * 3. POSTGRES_CONNECTION_STRING environment variable
   *
   * Per-tool request connection strings are blocked in the MCP request handler
   * unless --allow-tool-connection-string is explicitly enabled.
   */
  private getConnectionString(connectionStringArg?: string): string {
    const connectionString = resolveConnectionString({
      requestConnectionString: connectionStringArg,
      cliConnectionString: this.runtimeConfig.connectionString,
      envConnectionString: process.env.POSTGRES_CONNECTION_STRING
    });
    assertConnectionTargetAllowed(connectionString, this.runtimeConfig.allowedConnectionTargets);
    return connectionString;
  }

  /**
   * Load tools configuration and filter enabled tools
   */
  private loadAndFilterTools(): void {
    let toolsToEnable = [...this.availableToolsList];

    if (this.runtimeConfig.enabledTools) {
      const enabledToolNames = new Set(this.runtimeConfig.enabledTools);
      const availableToolNames = new Set(this.availableToolsList.map(tool => tool.name));
      const unknownToolNames = [...enabledToolNames].filter(toolName => !availableToolNames.has(toolName));

      if (unknownToolNames.length > 0) {
        throw new Error(`Unknown enabledTools configured: ${unknownToolNames.join(', ')}`);
      }

      toolsToEnable = this.availableToolsList.filter(tool => enabledToolNames.has(tool.name));
      console.error(`[MCP Info] Enabled tools from configuration: ${toolsToEnable.map(t => t.name).join(', ')}`);
    } else {
      if (this.availableToolsList.length > 0) {
        console.error('[MCP Info] No enabledTools allow-list provided. All available tools are listed, with security policy enforced at call time.');
      } else {
        console.error('[MCP Info] No tools configuration file provided and no tools loaded into availableToolsList.');
      }
    }
    
    this.enabledTools = toolsToEnable;
    this.enabledToolsMap = toolsToEnable.reduce((acc, tool) => {
      acc[tool.name] = tool;
      return acc;
    }, {} as Record<string, PostgresTool>);
  }

  private registerSignalHandlers(): void {
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      const handler: NodeJS.SignalsListener = async () => {
        await this.handleShutdownSignal();
      };
      this.signalHandlers.push({ signal, handler });
      process.on(signal, handler);
    }
  }

  private async handleShutdownSignal(): Promise<void> {
    if (this.signalShutdownPromise) {
      return this.signalShutdownPromise;
    }

    this.signalShutdownPromise = (async () => {
      try {
        await this.close();
        this.exitProcess(0);
      } catch (error) {
        console.error('Error during PostgreSQL MCP server shutdown:', sanitizeErrorMessage(error));
        this.exitProcess(1);
      }
    })();

    return this.signalShutdownPromise;
  }

  private removeSignalHandlers(): void {
    for (const { signal, handler } of this.signalHandlers) {
      process.removeListener(signal, handler);
    }
    this.signalHandlers = [];
  }

  /**
   * Clean up resources on shutdown
   */
  private async cleanup(): Promise<void> {
    if (this.cleanupPromise) {
      return this.cleanupPromise;
    }

    this.cleanupPromise = (async () => {
      console.error('Shutting down PostgreSQL MCP server...');
      this.removeSignalHandlers();
      const cleanupErrors: string[] = [];
      try {
        await DatabaseConnection.cleanupPools();
      } catch (error) {
        cleanupErrors.push(sanitizeErrorMessage(error));
      }

      if (this.server) {
        try {
          await this.server.close();
        } catch (error) {
          cleanupErrors.push(sanitizeErrorMessage(error));
        }
      }

      if (cleanupErrors.length > 0) {
        throw new Error(`Cleanup failed: ${cleanupErrors.join('; ')}`);
      }
    })();

    return this.cleanupPromise;
  }

  async close(): Promise<void> {
    await this.cleanup();
  }

  async handleToolCall(toolName: string, args: unknown): Promise<ToolOutput> {
    let auditEventEmitted = false;

    try {
      const tool = this.enabledToolsMap[toolName];

      if (!tool) {
        const wasAvailable = this.availableToolsList.some(t => t.name === toolName);
        const message = wasAvailable
          ? `Tool "${toolName}" is available but not enabled by the current server configuration.`
          : `Tool '${toolName}' is not enabled or does not exist.`;
        emitAuditEvent({
          reason: 'tool_not_enabled',
          toolName,
          args,
          securityPolicy: this.securityPolicy,
          allowToolConnectionString: this.allowToolConnectionString,
          availableButDisabled: wasAvailable,
          message
        });
        auditEventEmitted = true;
        throw new McpError(ErrorCode.MethodNotFound, message);
      }

      if (!this.allowToolConnectionString && hasToolSuppliedConnectionString(args)) {
        const message = 'Per-tool connection string arguments are disabled by default. Use the server --connection-string option, POSTGRES_CONNECTION_STRING, or explicitly enable --allow-tool-connection-string.';
        emitAuditEvent({
          reason: 'per_tool_connection_string_blocked',
          toolName,
          args,
          securityPolicy: this.securityPolicy,
          allowToolConnectionString: this.allowToolConnectionString,
          message
        });
        auditEventEmitted = true;
        throw new McpError(
          ErrorCode.InvalidParams,
          message
        );
      }

      if (this.allowToolConnectionString) {
        for (const connectionString of getToolSuppliedConnectionStrings(args)) {
          try {
            assertConnectionTargetAllowed(connectionString, this.runtimeConfig.allowedConnectionTargets);
          } catch (error) {
            emitAuditEvent({
              reason: 'connection_target_denied',
              toolName,
              args,
              securityPolicy: this.securityPolicy,
              allowToolConnectionString: this.allowToolConnectionString,
              message: error instanceof Error ? error.message : String(error)
            });
            auditEventEmitted = true;
            throw error;
          }
        }
      }

      const classification = classifyToolCall(toolName, args);
      if (!isToolCallAllowed(this.securityPolicy, classification)) {
        const message = explainPolicyDenial(this.securityPolicy, classification);
        emitAuditEvent({
          reason: 'security_policy_denied',
          toolName,
          args,
          securityPolicy: this.securityPolicy,
          allowToolConnectionString: this.allowToolConnectionString,
          classification,
          message
        });
        auditEventEmitted = true;
        throw new McpError(ErrorCode.InvalidParams, message);
      }

      return await tool.execute(args, this.getConnectionString.bind(this));
    } catch (error) {
      const errorMessage = sanitizeErrorMessage(error);
      if (!auditEventEmitted && isConnectionTargetDenial(error)) {
        emitAuditEvent({
          reason: 'connection_target_denied',
          toolName,
          args,
          securityPolicy: this.securityPolicy,
          allowToolConnectionString: this.allowToolConnectionString,
          message: errorMessage
        });
      }
      console.error(`Error handling request for tool ${toolName}:`, errorMessage);
      return {
        content: [{ type: 'text', text: `Error: ${errorMessage}` }],
        isError: true,
      } as ToolOutput;
    }
  }

  listTools(): ListToolsResult {
    return {
      tools: this.enabledTools.map(tool => PostgreSQLServer.toolMetadata(tool)),
    };
  }

  /**
   * Setup MCP request handlers
   */
  private setupToolHandlers(): void {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => this.listTools());

    // Handle tool execution requests
    // biome-ignore lint/suspicious/noExplicitAny: MCP SDK type inference issue
    this.server.setRequestHandler(CallToolRequestSchema, (async (request: any): Promise<ToolOutput> => {
      return this.handleToolCall(request.params.name, request.params.arguments);
    // biome-ignore lint/suspicious/noExplicitAny: MCP SDK type inference issue
    }) as any);
  }

  async run() {
    if (this.availableToolsList.length === 0 && !this.runtimeConfig.toolsConfigPath) {
        console.warn("[MCP Warning] No tools loaded and no tools config provided. Server will start with no active tools.");
    }
    
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`[MCP Info] Security mode: ${this.securityPolicy.mode}. Destructive operations: ${this.securityPolicy.allowDestructive ? 'allowed' : 'blocked'}. Per-tool connection strings: ${this.allowToolConnectionString ? 'allowed' : 'blocked'}.`);
    console.error(`[MCP Info] Filesystem workspace: ${process.env.POSTGRES_MCP_WORKSPACE_DIR || 'not configured'}. Max file bytes: ${process.env.POSTGRES_MCP_MAX_FILE_BYTES || '10485760'}.`);
    console.error(`[MCP Info] Pool max connections: ${process.env.POSTGRES_MCP_MAX_CONNECTIONS || DEFAULT_MAX_CONNECTIONS}. Pool idle timeout: ${process.env.POSTGRES_MCP_IDLE_TIMEOUT_MS || DEFAULT_POOL_IDLE_TIMEOUT_MS}. Connection timeout: ${process.env.POSTGRES_MCP_CONNECTION_TIMEOUT_MS || DEFAULT_CONNECTION_TIMEOUT_MS}.`);
    console.error(`[MCP Info] Statement timeout: ${process.env.POSTGRES_MCP_STATEMENT_TIMEOUT_MS || DEFAULT_STATEMENT_TIMEOUT_MS}. Query timeout: ${process.env.POSTGRES_MCP_QUERY_TIMEOUT_MS || DEFAULT_QUERY_TIMEOUT_MS}. Lock timeout: ${process.env.POSTGRES_MCP_LOCK_TIMEOUT_MS || DEFAULT_LOCK_TIMEOUT_MS}. Idle transaction timeout: ${process.env.POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS || DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS}.`);
    console.error('PostgreSQL MCP server running on stdio');
  }
}

/**
 * All available PostgreSQL MCP tools
 * Organized by category for maintainability
 */
export const allTools: PostgresTool[] = [
  // Core Analysis & Debugging
  analyzeDatabaseTool,
  debugDatabaseTool,
  
  // Schema & Structure Management (Meta-Tools)
  manageSchemaTools,
  manageFunctionsTool,
  manageTriggersTools,
  manageIndexesTool,
  manageConstraintsTool,
  manageRLSTool,
  
  // User & Security Management
  manageUsersTool,
  
  // Query & Performance Management
  manageQueryTool,
  
  // Data Operations (Enhancement Tools)
  executeQueryTool,
  executeMutationTool,
  executeSqlTool,
  
  // Documentation & Metadata
  manageCommentsTool,
  
  // Data Migration & Monitoring
  exportTableDataTool,
  importTableDataTool,
  copyBetweenDatabasesTool,
  monitorDatabaseTool
];

export async function main(argv = process.argv): Promise<void> {
  const options = parseCliOptions(argv);
  const runtimeConfig = createRuntimeConfig(options);
  const serverInstance = new PostgreSQLServer(allTools, runtimeConfig);
  try {
    await serverInstance.run();
  } catch (error) {
    try {
      await serverInstance.close();
    } catch (cleanupError) {
      console.error('Error during PostgreSQL MCP server cleanup after failed startup:', sanitizeErrorMessage(cleanupError));
    }
    throw error;
  }
}

const isCliEntrypoint = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isCliEntrypoint) {
  main().catch(error => {
    console.error('Failed to run the server:', sanitizeErrorMessage(error));
    process.exit(1);
  });
}
