import { existsSync, readFileSync } from 'node:fs';

const errors = [];

function requireFile(path) {
  if (!existsSync(path)) {
    errors.push(`Missing ${path}.`);
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

function requireNoTrailingWhitespace(path, text) {
  text.split(/\r?\n/).forEach((line, index) => {
    if (/[ \t]+$/.test(line)) {
      errors.push(`${path}:${index + 1} must not contain trailing whitespace.`);
    }
  });
}

const dockerfilePath = 'Dockerfile';
const entrypointPath = 'docker-entrypoint.sh';
const dockerignorePath = '.dockerignore';
const dockerfile = requireFile(dockerfilePath);
const entrypoint = requireFile(entrypointPath);
const dockerignore = requireFile(dockerignorePath);

for (const [path, text] of [
  [dockerfilePath, dockerfile],
  [entrypointPath, entrypoint],
  [dockerignorePath, dockerignore]
]) {
  requireNoTrailingWhitespace(path, text);
}

requireText(dockerfilePath, dockerfile, 'FROM node:20-alpine AS build');
requireText(dockerfilePath, dockerfile, 'FROM node:20-alpine AS runtime');
requireText(dockerfilePath, dockerfile, 'RUN npm ci --ignore-scripts');
requireText(dockerfilePath, dockerfile, 'COPY src ./src');
requireText(dockerfilePath, dockerfile, 'RUN npm run build');
requireText(dockerfilePath, dockerfile, 'RUN npm prune --omit=dev --ignore-scripts');
requireText(dockerfilePath, dockerfile, 'ENV NODE_ENV=production');
requireText(dockerfilePath, dockerfile, 'COPY --from=build --chown=node:node /app/node_modules ./node_modules');
requireText(dockerfilePath, dockerfile, 'COPY --from=build --chown=node:node /app/build ./build');
requireText(dockerfilePath, dockerfile, 'USER node');
requireText(dockerfilePath, dockerfile, 'ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]');
forbidText(dockerfilePath, dockerfile, 'node:lts');
forbidText(dockerfilePath, dockerfile, 'COPY . .');
forbidText(dockerfilePath, dockerfile, 'USER root');

requireText(entrypointPath, entrypoint, '#!/bin/sh');
requireText(entrypointPath, entrypoint, 'set -e');
requireText(entrypointPath, entrypoint, 'exec node build/index.js "$@"');
forbidText(entrypointPath, entrypoint, 'CMD=');
forbidText(entrypointPath, entrypoint, 'CONNECTION_STRING=');
forbidText(entrypointPath, entrypoint, 'exec $');

requireText(dockerignorePath, dockerignore, 'node_modules');
requireText(dockerignorePath, dockerignore, 'build');
requireText(dockerignorePath, dockerignore, '.git');
requireText(dockerignorePath, dockerignore, '.env');

if (errors.length > 0) {
  console.error('Docker verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Docker runtime files verified.');
