import { existsSync, readFileSync } from 'node:fs';

const errors = [];

function readWorkflow(path) {
  if (!existsSync(path)) {
    errors.push(`Missing workflow file ${path}.`);
    return '';
  }

  return readFileSync(path, 'utf8');
}

function requireText(path, text, expected) {
  if (!text.includes(expected)) {
    errors.push(`${path} must include "${expected}".`);
  }
}

function forbidText(path, text, forbidden) {
  if (text.includes(forbidden)) {
    errors.push(`${path} must not include "${forbidden}".`);
  }
}

function requireNoTabsOrTrailingWhitespace(path, text) {
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    if (line.includes('\t')) {
      errors.push(`${path}:${index + 1} must not contain tab indentation.`);
    }

    if (/[ \t]+$/.test(line)) {
      errors.push(`${path}:${index + 1} must not contain trailing whitespace.`);
    }
  });
}

const ciPath = '.github/workflows/ci.yml';
const publishPath = '.github/workflows/publish.yml';
const ci = readWorkflow(ciPath);
const publish = readWorkflow(publishPath);
const workflows = [
  [ciPath, ci],
  [publishPath, publish]
];

for (const [path, text] of workflows) {
  requireNoTabsOrTrailingWhitespace(path, text);
  forbidText(path, text, 'pull_request_target');
  requireText(path, text, 'uses: actions/checkout@v4');
  requireText(path, text, 'uses: actions/setup-node@v4');
  requireText(path, text, "node-version: '18'");
  requireText(path, text, 'run: npm ci');
  requireText(path, text, 'run: npm run lint');
  requireText(path, text, 'run: npm run prepublishOnly');
  requireText(path, text, 'run: npm run test:integration');
  requireText(path, text, 'image: postgres:17-alpine');
  requireText(path, text, 'POSTGRES_MCP_INTEGRATION_CONNECTION_STRING: postgresql://postgres:postgres@localhost:5432/postgres');
}

requireText(ciPath, ci, 'pull_request:');
requireText(ciPath, ci, 'push:');
requireText(ciPath, ci, '      - main');
requireText(ciPath, ci, 'permissions:\n  contents: read');
requireText(ciPath, ci, '  verify:');
requireText(ciPath, ci, '  postgres-integration:');
requireText(ciPath, ci, 'cache: npm');
requireText(ciPath, ci, 'run: node build/index.js --help');
requireText(ciPath, ci, 'run: npm pack --dry-run --cache .npm-cache');

requireText(publishPath, publish, 'release:');
requireText(publishPath, publish, 'types: [published]');
requireText(publishPath, publish, 'contents: read');
requireText(publishPath, publish, 'id-token: write');
requireText(publishPath, publish, "registry-url: 'https://registry.npmjs.org'");
requireText(publishPath, publish, 'run: node build/index.js --help');
requireText(publishPath, publish, 'run: npm pack --dry-run');
requireText(publishPath, publish, 'run: npm publish --access public --provenance');
requireText(publishPath, publish, 'NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}');

if (errors.length > 0) {
  console.error('Workflow verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('GitHub Actions workflows verified.');
