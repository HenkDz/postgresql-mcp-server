import fs from 'node:fs';
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
  DOCUMENTED_TOOLS_CONFIG_KEYS,
  PACKAGE_VERSION,
  allTools,
  createCliProgram
} from '../build/index.js';
import { zodToJsonSchema } from 'zod-to-json-schema';

const toolSchemas = fs.readFileSync('TOOL_SCHEMAS.md', 'utf8');
const readme = fs.readFileSync('README.md', 'utf8');
const usage = fs.readFileSync('docs/USAGE.md', 'utf8');
const packageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const packageLock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const expectedToolCount = allTools.length;
const errors = [];

function requireText(sourceName, sourceText, expectedText) {
  if (!sourceText.includes(expectedText)) {
    errors.push(`${sourceName} must include "${expectedText}".`);
  }
}

function documentedToolNames(markdown) {
  const names = new Set();
  const toolLines = markdown.matchAll(/^\*\*Tool:\*\*\s*(.+)$/gm);

  for (const match of toolLines) {
    const codeNames = match[1].matchAll(/`(pg_[a-z_]+)`/g);
    for (const codeName of codeNames) {
      names.add(codeName[1]);
    }
  }

  return names;
}

function expectedLongCliOptions() {
  return createCliProgram().options
    .map((option) => option.long)
    .filter(Boolean)
    .sort();
}

function requireEverywhere(label, values, sources) {
  for (const value of values) {
    for (const [sourceName, sourceText] of Object.entries(sources)) {
      requireText(sourceName, sourceText, value);
    }
  }
  if (values.length !== new Set(values).size) {
    errors.push(`${label} contains duplicate entries.`);
  }
}

requireText('TOOL_SCHEMAS.md', toolSchemas, `all ${expectedToolCount} tools`);
requireText('README.md', readme, `${expectedToolCount} powerful tools`);
requireText('README.md', readme, `All ${expectedToolCount} tool parameters`);
requireText('README.md', readme, `POSTGRES_MCP_MAX_CONNECTIONS=${DEFAULT_MAX_CONNECTIONS}`);
requireText('README.md', readme, `POSTGRES_MCP_IDLE_TIMEOUT_MS=${DEFAULT_POOL_IDLE_TIMEOUT_MS}`);
requireText('README.md', readme, `POSTGRES_MCP_CONNECTION_TIMEOUT_MS=${DEFAULT_CONNECTION_TIMEOUT_MS}`);
requireText('README.md', readme, `POSTGRES_MCP_STATEMENT_TIMEOUT_MS=${DEFAULT_STATEMENT_TIMEOUT_MS}`);
requireText('README.md', readme, `POSTGRES_MCP_QUERY_TIMEOUT_MS=${DEFAULT_QUERY_TIMEOUT_MS}`);
requireText('README.md', readme, `POSTGRES_MCP_LOCK_TIMEOUT_MS=${DEFAULT_LOCK_TIMEOUT_MS}`);
requireText('README.md', readme, `POSTGRES_MCP_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS=${DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS}`);
requireText('docs/USAGE.md', usage, `default ${DEFAULT_MAX_CONNECTIONS}`);
requireText('docs/USAGE.md', usage, `default ${DEFAULT_POOL_IDLE_TIMEOUT_MS} ms`);
requireText('docs/USAGE.md', usage, `default ${DEFAULT_CONNECTION_TIMEOUT_MS} ms`);
requireText('docs/USAGE.md', usage, `default ${DEFAULT_STATEMENT_TIMEOUT_MS} ms`);
requireText('docs/USAGE.md', usage, `default ${DEFAULT_QUERY_TIMEOUT_MS} ms`);
requireText('docs/USAGE.md', usage, `default ${DEFAULT_LOCK_TIMEOUT_MS} ms`);
requireText('docs/USAGE.md', usage, `default ${DEFAULT_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS} ms`);
requireText('README.md', readme, 'unknown-key');
requireText('docs/USAGE.md', usage, 'unknown keys');

const documentedTools = documentedToolNames(toolSchemas);
const runtimeToolNames = allTools.map((tool) => tool.name);

for (const toolName of runtimeToolNames) {
  if (!documentedTools.has(toolName)) {
    errors.push(`TOOL_SCHEMAS.md is missing a **Tool:** entry for ${toolName}.`);
  }
}

for (const toolName of documentedTools) {
  if (!runtimeToolNames.includes(toolName)) {
    errors.push(`TOOL_SCHEMAS.md documents unknown tool ${toolName}.`);
  }
}

for (const tool of allTools) {
  const schema = zodToJsonSchema(tool.inputSchema);
  if (schema.type !== 'object') {
    errors.push(`${tool.name} input schema must convert to a root JSON object.`);
  }

  if (schema.additionalProperties !== false) {
    errors.push(`${tool.name} root input schema must reject unknown fields.`);
  }
}

const runtimeCliOptions = expectedLongCliOptions();
const documentedCliOptions = [...DOCUMENTED_CLI_OPTIONS].sort();
if (JSON.stringify(runtimeCliOptions) !== JSON.stringify(documentedCliOptions)) {
  errors.push(`DOCUMENTED_CLI_OPTIONS must match createCliProgram long options. Runtime=${runtimeCliOptions.join(', ')} Documented=${documentedCliOptions.join(', ')}`);
}

requireEverywhere('CLI options', DOCUMENTED_CLI_OPTIONS, {
  'README.md': readme,
  'docs/USAGE.md': usage
});

requireEverywhere('environment variables', DOCUMENTED_ENVIRONMENT_VARIABLES, {
  'README.md': readme,
  'docs/USAGE.md': usage
});

requireEverywhere('tools config keys', DOCUMENTED_TOOLS_CONFIG_KEYS, {
  'README.md': readme,
  'docs/USAGE.md': usage
});

if (packageJson.version !== PACKAGE_VERSION) {
  errors.push(`PACKAGE_VERSION (${PACKAGE_VERSION}) must match package.json version (${packageJson.version}).`);
}

if (packageLock.version !== PACKAGE_VERSION) {
  errors.push(`PACKAGE_VERSION (${PACKAGE_VERSION}) must match package-lock.json root version (${packageLock.version}).`);
}

if (packageLock.packages?.['']?.version !== PACKAGE_VERSION) {
  errors.push(`PACKAGE_VERSION (${PACKAGE_VERSION}) must match package-lock.json packages[""].version (${packageLock.packages?.['']?.version}).`);
}

if (errors.length > 0) {
  console.error('Documentation verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Documentation verified for ${expectedToolCount} runtime tools, ${DOCUMENTED_CLI_OPTIONS.length} CLI options, ${DOCUMENTED_ENVIRONMENT_VARIABLES.length} environment variables, ${DOCUMENTED_TOOLS_CONFIG_KEYS.length} tools config keys, and package version ${PACKAGE_VERSION}.`);
