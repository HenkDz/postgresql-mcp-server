import { existsSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const buildDir = 'build';
const sourceDir = 'src';
const staleOutputs = [];
const missingOutputs = [];

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

function collectBuildOutput(entryPath) {
    const relativeBuildPath = relative(buildDir, entryPath);
    if (
      !relativeBuildPath.endsWith('.js') &&
      !relativeBuildPath.endsWith('.d.ts') &&
      !relativeBuildPath.endsWith('.js.map')
    ) {
      return;
    }

    const withoutSourceMap = relativeBuildPath.replace(/\.js\.map$/, '.js');
    const withoutDeclaration = withoutSourceMap.replace(/\.d\.ts$/, '.ts');
    const sourcePath = join(sourceDir, withoutDeclaration.replace(/\.js$/, '.ts'));
    if (!existsSync(sourcePath)) {
      staleOutputs.push(relativeBuildPath.split(sep).join('/'));
    }
}

function verifySourceOutput(entryPath) {
  if (!entryPath.endsWith('.ts') || entryPath.endsWith('.test.ts')) {
    return;
  }

  const relativeSourcePath = relative(sourceDir, entryPath);
  const relativeOutputBase = relativeSourcePath.replace(/\.ts$/, '');
  const expectedOutputs = [
    `${relativeOutputBase}.js`,
    `${relativeOutputBase}.d.ts`,
    `${relativeOutputBase}.js.map`,
  ];

  for (const output of expectedOutputs) {
    if (!existsSync(join(buildDir, output))) {
      missingOutputs.push(output.split(sep).join('/'));
    }
  }
}

walk(buildDir, collectBuildOutput);
walk(sourceDir, verifySourceOutput);

if (staleOutputs.length > 0) {
  console.error('Build output contains files without matching source:');
  for (const output of staleOutputs) {
    console.error(`- build/${output}`);
  }
}

if (missingOutputs.length > 0) {
  console.error('Source files are missing expected build outputs:');
  for (const output of missingOutputs) {
    console.error(`- build/${output}`);
  }
}

if (staleOutputs.length > 0 || missingOutputs.length > 0) {
  process.exit(1);
}
