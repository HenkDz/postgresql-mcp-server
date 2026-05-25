import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PACKAGE_VERSION } from '../build/index.js';

const errors = [];
const postgresEnvKeys = [
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
];

function cleanEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of postgresEnvKeys) {
    delete env[key];
  }
  return { ...env, ...overrides };
}

function runCli(args, options = {}) {
  return spawnSync(process.execPath, ['build/index.js', ...args], {
    encoding: 'utf8',
    timeout: 5000,
    env: cleanEnv(options.env)
  });
}

function expectSuccess(name, result, expectedStdout) {
  if (result.status !== 0) {
    errors.push(`${name}: expected exit code 0, got ${result.status}. stderr=${result.stderr}`);
    return;
  }

  if (expectedStdout !== undefined && !result.stdout.includes(expectedStdout)) {
    errors.push(`${name}: expected stdout to include "${expectedStdout}", got ${result.stdout}`);
  }
}

function expectFailure(name, result, expectedMessage, forbiddenMessages = []) {
  if (result.status === 0 || result.status === null) {
    errors.push(`${name}: expected nonzero exit code, got ${result.status}. stdout=${result.stdout} stderr=${result.stderr}`);
    return;
  }

  if (!result.stderr.includes('Failed to run the server:')) {
    errors.push(`${name}: stderr should include the top-level startup failure prefix. stderr=${result.stderr}`);
  }

  if (!result.stderr.includes(expectedMessage)) {
    errors.push(`${name}: stderr should include "${expectedMessage}". stderr=${result.stderr}`);
  }

  if (result.stderr.includes('Error: Failed to run the server')) {
    errors.push(`${name}: stderr should not include an unsanitized stack-style Error prefix. stderr=${result.stderr}`);
  }

  for (const forbiddenMessage of forbiddenMessages) {
    if (result.stderr.includes(forbiddenMessage)) {
      errors.push(`${name}: stderr should not include "${forbiddenMessage}". stderr=${result.stderr}`);
    }
  }
}

const tempDir = mkdtempSync(join(tmpdir(), 'postgres-mcp-cli-'));

try {
  expectSuccess('version', runCli(['--version']), PACKAGE_VERSION);
  expectSuccess('help', runCli(['--help']), '--allowed-connection-target');

  expectFailure(
    'invalid boolean environment',
    runCli([], { env: { POSTGRES_MCP_ALLOW_DESTRUCTIVE: 'yes' } }),
    'POSTGRES_MCP_ALLOW_DESTRUCTIVE must be "true" or "false".'
  );

  expectFailure(
    'invalid numeric environment',
    runCli([], { env: { POSTGRES_MCP_MAX_FILE_BYTES: '0' } }),
    'POSTGRES_MCP_MAX_FILE_BYTES must be a positive integer.'
  );

  expectFailure(
    'invalid connection target allowlist',
    runCli([], { env: { POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS: 'db.*.internal/app' } }),
    'host only supports "*" as a full-field wildcard'
  );

  expectFailure(
    'connection string outside allowlist',
    runCli([], {
      env: {
        POSTGRES_CONNECTION_STRING: 'postgresql://readonly:secret-password@other.internal:5432/app',
        POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS: 'readonly@db.internal:5432/app'
      }
    }),
    'is not allowed by the configured connection target allowlist',
    ['secret-password']
  );

  const malformedConfigPath = join(tempDir, 'malformed-tools.json');
  writeFileSync(malformedConfigPath, '{"enabledTools": [');
  expectFailure(
    'malformed tools config',
    runCli(['--tools-config', malformedConfigPath]),
    'Failed to load tools configuration file'
  );

  const invalidConfigPath = join(tempDir, 'invalid-tools.json');
  writeFileSync(invalidConfigPath, JSON.stringify({ enabledTools: 'pg_execute_query' }));
  expectFailure(
    'invalid tools config field type',
    runCli(['--tools-config', invalidConfigPath]),
    'enabledTools must be an array of tool names.'
  );

  const unknownConfigPath = join(tempDir, 'unknown-tools-key.json');
  writeFileSync(unknownConfigPath, JSON.stringify({ enabledTools: ['pg_execute_query'], securitymode: 'unsafe' }));
  expectFailure(
    'unknown tools config key',
    runCli(['--tools-config', unknownConfigPath]),
    'Unknown tools config key(s): securitymode'
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error('CLI verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('CLI startup verification passed.');
