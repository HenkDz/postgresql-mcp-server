import { readFileSync } from 'node:fs';
import {
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS,
  DEFAULT_LOCK_TIMEOUT_MS,
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_POOL_IDLE_TIMEOUT_MS,
  DEFAULT_QUERY_TIMEOUT_MS,
  DEFAULT_STATEMENT_TIMEOUT_MS,
  DOCUMENTED_CLI_OPTIONS,
  DOCUMENTED_ENVIRONMENT_VARIABLES,
  DOCUMENTED_TOOLS_CONFIG_KEYS
} from '../build/index.js';

const errors = [];
const security = readFileSync('SECURITY.md', 'utf8');
const readme = readFileSync('README.md', 'utf8');
const docsIndex = readFileSync('docs/INDEX.md', 'utf8');
const usage = readFileSync('docs/USAGE.md', 'utf8');
const postgresRoles = readFileSync('docs/POSTGRES_ROLES.md', 'utf8');

function requireText(sourceName, sourceText, expectedText) {
  if (!sourceText.includes(expectedText)) {
    errors.push(`${sourceName} must include "${expectedText}".`);
  }
}

for (const expected of [
  'securityMode',
  'allowDestructive',
  'allowToolConnectionString',
  'enabledTools',
  'POSTGRES_MCP_WORKSPACE_DIR',
  'POSTGRES_MCP_MAX_FILE_BYTES',
  'POSTGRES_MCP_AUDIT_FILE',
  'POSTGRES_MCP_MAX_CONNECTIONS',
  'POSTGRES_MCP_IDLE_TIMEOUT_MS',
  'POSTGRES_MCP_CONNECTION_TIMEOUT_MS',
  'POSTGRES_MCP_STATEMENT_TIMEOUT_MS',
  'POSTGRES_MCP_QUERY_TIMEOUT_MS',
  'POSTGRES_MCP_LOCK_TIMEOUT_MS',
  'POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS',
  'POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS',
  '[MCP Audit]',
  '[MCP Audit Error]',
  'JSONL',
  'POSTGRES_MCP_DEBUG_SQL',
  'readonly',
  'write',
  'admin',
  'unsafe',
  'least-privilege PostgreSQL role',
  `default ${DEFAULT_MAX_CONNECTIONS} max pool connections`,
  `${DEFAULT_POOL_IDLE_TIMEOUT_MS} ms pool idle timeout`,
  `${DEFAULT_CONNECTION_TIMEOUT_MS} ms connection timeout`,
  `default ${DEFAULT_STATEMENT_TIMEOUT_MS} ms statement timeout`,
  `${DEFAULT_QUERY_TIMEOUT_MS} ms query timeout`,
  `${DEFAULT_LOCK_TIMEOUT_MS} ms lock timeout`,
  `${DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS} ms idle-in-transaction timeout`,
  'The server does not prompt interactively for approvals',
  'The Docker image uses a multi-stage build',
  'non-root `node` user',
  'Use `enabledTools` to reduce the available surface',
  'elevated role attributes',
  'broad grants',
  'delegable grants'
]) {
  requireText('SECURITY.md', security, expected);
}

for (const option of [
  '--allow-destructive',
  '--allow-tool-connection-string',
  '--allowed-connection-target',
  '--workspace-dir',
  '--audit-file',
  '--max-connections',
  '--security-mode'
]) {
  if (!DOCUMENTED_CLI_OPTIONS.includes(option)) {
    errors.push(`Runtime DOCUMENTED_CLI_OPTIONS is missing ${option}.`);
  }
  requireText('SECURITY.md', security, option);
}

for (const envName of [
  'POSTGRES_CONNECTION_STRING',
  'POSTGRES_MCP_ALLOW_DESTRUCTIVE',
  'POSTGRES_MCP_ALLOW_TOOL_CONNECTION_STRING',
  'POSTGRES_MCP_AUDIT_FILE',
  'POSTGRES_MCP_MAX_CONNECTIONS',
  'POSTGRES_MCP_IDLE_TIMEOUT_MS',
  'POSTGRES_MCP_CONNECTION_TIMEOUT_MS',
  'POSTGRES_MCP_ALLOWED_CONNECTION_TARGETS'
]) {
  if (!DOCUMENTED_ENVIRONMENT_VARIABLES.includes(envName)) {
    errors.push(`Runtime DOCUMENTED_ENVIRONMENT_VARIABLES is missing ${envName}.`);
  }
  requireText('SECURITY.md', security, envName);
}

for (const key of ['enabledTools', 'auditFile', 'allowedConnectionTargets']) {
  if (!DOCUMENTED_TOOLS_CONFIG_KEYS.includes(key)) {
    errors.push(`Runtime DOCUMENTED_TOOLS_CONFIG_KEYS is missing ${key}.`);
  }
  requireText('SECURITY.md', security, key);
}

requireText('README.md', readme, './SECURITY.md');
requireText('README.md', readme, './docs/POSTGRES_ROLES.md');
requireText('docs/INDEX.md', docsIndex, '[Security Posture](../SECURITY.md)');
requireText('docs/INDEX.md', docsIndex, '[PostgreSQL Role Templates](POSTGRES_ROLES.md)');
requireText('docs/USAGE.md', usage, '[PostgreSQL Role Templates](POSTGRES_ROLES.md)');
requireText('SECURITY.md', security, 'docs/POSTGRES_ROLES.md');

for (const expected of [
  'Do not use a superuser role for routine MCP access',
  'NOCREATEDB',
  'NOCREATEROLE',
  'NOBYPASSRLS',
  'GRANT CONNECT ON DATABASE',
  'GRANT SELECT ON ALL TABLES',
  'GRANT SELECT, INSERT, UPDATE, DELETE',
  'GRANT USAGE, CREATE ON SCHEMA',
  'GRANT pg_monitor',
  'short-lived credential',
  'Avoid `SUPERUSER`',
  '--security-mode unsafe --allow-destructive'
]) {
  requireText('docs/POSTGRES_ROLES.md', postgresRoles, expected);
}

if (errors.length > 0) {
  console.error('Security documentation verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Security documentation verified.');
