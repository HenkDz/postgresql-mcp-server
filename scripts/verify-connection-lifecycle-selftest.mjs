import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const verifierPath = path.resolve('scripts/verify-connection-lifecycle.mjs');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'postgres-mcp-connection-lifecycle-'));

function writeFixture(directoryName, sourceText) {
  const directoryPath = path.join(tempRoot, directoryName);
  fs.mkdirSync(directoryPath, { recursive: true });
  fs.writeFileSync(path.join(directoryPath, 'fixture.ts'), sourceText);
  return directoryPath;
}

function runVerifier(fixtureDirectory) {
  return spawnSync(process.execPath, [verifierPath, fixtureDirectory], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

try {
  const goodFixture = writeFixture('good', `
    async function execute(input: { connectionString?: string }, getConnectionString: (value?: string) => string) {
      const db = {
        connect: async (_connectionString: string) => {},
        disconnect: async () => {}
      };
      const resolvedConnectionString = getConnectionString(input.connectionString);

      try {
        await db.connect(resolvedConnectionString);
      } finally {
        await db.disconnect();
      }
    }
  `);

  const directResolverFixture = writeFixture('direct-resolver', `
    async function execute(input: { connectionString?: string }, getConnectionString: (value?: string) => string) {
      const db = {
        connect: async (_connectionString: string) => {},
        disconnect: async () => {}
      };

      try {
        await db.connect(getConnectionString(input.connectionString));
      } finally {
        await db.disconnect();
      }
    }
  `);

  const rawConnectFixture = writeFixture('raw-connect', `
    async function execute(input: { connectionString?: string }, getConnectionString: (value?: string) => string) {
      const db = {
        connect: async (_connectionString?: string) => {},
        disconnect: async () => {}
      };

      try {
        await db.connect(input.connectionString);
      } finally {
        await db.disconnect();
      }
    }
  `);

  const fakeResolverFixture = writeFixture('fake-resolver', `
    async function execute(input: { connectionString?: string }, getConnectionString: (value?: string) => string) {
      const db = {
        connect: async (_connectionString: string) => {},
        disconnect: async () => {}
      };

      try {
        await db.connect(\`\${getConnectionString.name}:\${input.connectionString}\`);
      } finally {
        await db.disconnect();
      }
    }
  `);

  const successFixtures = [goodFixture, directResolverFixture];
  for (const fixtureDirectory of successFixtures) {
    const result = runVerifier(fixtureDirectory);
    if (result.status !== 0) {
      throw new Error(`Expected fixture ${path.basename(fixtureDirectory)} to pass, got exit ${result.status}:\n${result.stderr || result.stdout}`);
    }
  }

  const failureFixtures = [rawConnectFixture, fakeResolverFixture];
  for (const fixtureDirectory of failureFixtures) {
    const result = runVerifier(fixtureDirectory);
    const output = `${result.stderr}\n${result.stdout}`;

    if (result.status === 0) {
      throw new Error(`Expected fixture ${path.basename(fixtureDirectory)} to fail, but it passed.`);
    }

    if (!output.includes('must connect with a value resolved through getConnectionString().')) {
      throw new Error(`Expected fixture ${path.basename(fixtureDirectory)} to report resolver enforcement, got:\n${output}`);
    }
  }

  console.log('Connection lifecycle verifier self-test passed.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
