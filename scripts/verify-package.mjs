import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const errors = [];

function walk(directory, onFile) {
  if (!existsSync(directory)) {
    return;
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(entryPath, onFile);
      continue;
    }

    onFile(entryPath);
  }
}

function toPosixPath(filePath) {
  return filePath.split(sep).join('/');
}

function runPackDryRun() {
  const command = process.env.npm_execpath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = process.env.npm_execpath
    ? [process.env.npm_execpath, 'pack', '--dry-run', '--json', '--cache', '.npm-cache']
    : ['pack', '--dry-run', '--json', '--cache', '.npm-cache'];
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  if (result.status !== 0) {
    if (result.stdout) {
      console.error(result.stdout);
    }
    if (result.stderr) {
      console.error(result.stderr);
    }
    const errorDetail = result.error ? `: ${result.error.message}` : '';
    throw new Error(`npm pack --dry-run failed with exit code ${result.status}${errorDetail}.`);
  }

  return JSON.parse(result.stdout);
}

function expectedBuildFilesFromSource() {
  const expectedFiles = [];

  walk('src', (entryPath) => {
    if (!entryPath.endsWith('.ts') || entryPath.endsWith('.test.ts')) {
      return;
    }

    const relativeSourcePath = toPosixPath(relative('src', entryPath));
    const outputBase = relativeSourcePath.replace(/\.ts$/, '');
    expectedFiles.push(`build/${outputBase}.js`);
    expectedFiles.push(`build/${outputBase}.d.ts`);
    expectedFiles.push(`build/${outputBase}.js.map`);
  });

  return expectedFiles;
}

function scriptFilesFromPackageScripts() {
  const scriptFiles = new Set();

  for (const script of Object.values(packageJson.scripts ?? {})) {
    for (const match of script.matchAll(/\bnode\s+(scripts\/[^\s&|]+\.mjs)\b/g)) {
      scriptFiles.add(match[1]);
    }
  }

  return [...scriptFiles].sort();
}

function matchesForbiddenPattern(filePath) {
  return filePath.startsWith('src/') ||
    filePath.startsWith('node_modules/') ||
    filePath.startsWith('.git/') ||
    filePath.startsWith('.npm-cache/') ||
    filePath === 'package-lock.json' ||
    filePath === 'tsconfig.json' ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.js') ||
    filePath.endsWith('.log') ||
    filePath.startsWith('.env');
}

const packResults = runPackDryRun();
if (!Array.isArray(packResults) || packResults.length !== 1) {
  errors.push('npm pack --dry-run --json must return exactly one package result.');
}

const packResult = packResults[0] ?? { files: [] };
if (packResult.name !== packageJson.name) {
  errors.push(`Pack result name ${packResult.name} does not match package.json name ${packageJson.name}.`);
}
if (packResult.version !== packageJson.version) {
  errors.push(`Pack result version ${packResult.version} does not match package.json version ${packageJson.version}.`);
}

const packedFiles = new Set((packResult.files ?? []).map((file) => file.path));
const requiredFiles = [
  'package.json',
  'README.md',
  'SECURITY.md',
  'TOOL_SCHEMAS.md',
  'LICENSE',
  packageJson.main,
  packageJson.types,
  ...Object.values(packageJson.bin ?? {}),
  'docs/INDEX.md',
  'docs/USAGE.md',
  'docs/POSTGRES_ROLES.md',
  'docs/TECHNICAL.md',
  'docs/DEVELOPER.md',
  'docs/DEVELOPMENT.md',
  ...scriptFilesFromPackageScripts(),
  ...expectedBuildFilesFromSource()
];

for (const requiredFile of new Set(requiredFiles)) {
  if (!packedFiles.has(requiredFile)) {
    errors.push(`Package is missing required file ${requiredFile}.`);
  }
}

const allowedTopLevelFiles = new Set(['LICENSE', 'README.md', 'SECURITY.md', 'TOOL_SCHEMAS.md', 'package.json']);
const allowedTopLevelDirectories = new Set(['build', 'docs', 'scripts']);

for (const filePath of packedFiles) {
  const [topLevel] = filePath.split('/');
  if (!allowedTopLevelFiles.has(filePath) && !allowedTopLevelDirectories.has(topLevel)) {
    errors.push(`Package contains unexpected top-level path ${filePath}.`);
  }

  if (matchesForbiddenPattern(filePath)) {
    errors.push(`Package contains forbidden development artifact ${filePath}.`);
  }
}

for (const filePath of packedFiles) {
  if (filePath.startsWith('build/') && !filePath.endsWith('.js') && !filePath.endsWith('.d.ts') && !filePath.endsWith('.js.map')) {
    errors.push(`Build package file has unexpected extension: ${filePath}.`);
  }
}

if (packResult.entryCount !== packedFiles.size) {
  errors.push(`Pack entryCount ${packResult.entryCount} does not match unique file count ${packedFiles.size}.`);
}

const prepublishOnly = packageJson.scripts?.prepublishOnly ?? '';
for (const scriptName of Object.keys(packageJson.scripts ?? {}).filter((name) => name.startsWith('verify:')).sort()) {
  if (!prepublishOnly.includes(`npm run ${scriptName}`)) {
    errors.push(`prepublishOnly must run ${scriptName}.`);
  }
}

if (errors.length > 0) {
  console.error('Package verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`Package verified with ${packedFiles.size} files and no forbidden development artifacts.`);
