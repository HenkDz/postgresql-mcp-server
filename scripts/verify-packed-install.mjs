import { existsSync, mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const errors = [];

function npmCommandArgs(args) {
  return process.env.npm_execpath
    ? { command: process.execPath, args: [process.env.npm_execpath, ...args] }
    : { command: process.platform === 'win32' ? 'npm.cmd' : 'npm', args };
}

function runNpm(args, options = {}) {
  const command = npmCommandArgs(args);
  return spawnSync(command.command, command.args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}

function runInstalledBin(args, options = {}) {
  const binName = process.platform === 'win32' ? 'postgres-mcp.cmd' : 'postgres-mcp';
  const binPath = join(installDir, 'node_modules', '.bin', binName);
  if (!existsSync(binPath)) {
    return {
      status: 1,
      stdout: '',
      stderr: `Installed bin not found: ${binPath}`
    };
  }

  if (process.platform === 'win32') {
    return runNpm(['exec', '--', 'postgres-mcp', ...args], options);
  }

  return spawnSync(binPath, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
}

function requireSuccess(name, result) {
  if (result.status !== 0) {
    const error = result.error ? ` error=${result.error.message}` : '';
    errors.push(`${name} failed with exit code ${result.status}.${error} stdout=${result.stdout} stderr=${result.stderr}`);
    return false;
  }

  return true;
}

function requireIncludes(name, value, expected) {
  if (!value.includes(expected)) {
    errors.push(`${name} should include "${expected}", got ${value}`);
  }
}

const tempRoot = mkdtempSync(join(tmpdir(), 'postgres-mcp-pack-install-'));
const packDir = join(tempRoot, 'pack');
const installDir = join(tempRoot, 'install');
const npmCacheDir = join(tempRoot, 'npm-cache');
mkdirSync(packDir);
mkdirSync(installDir);

try {
  const packResult = runNpm(['pack', '--json', '--pack-destination', packDir, '--cache', npmCacheDir]);
  if (requireSuccess('npm pack', packResult)) {
    const parsedPackResult = JSON.parse(packResult.stdout);
    const tarballName = parsedPackResult[0]?.filename;
    if (!tarballName) {
      errors.push('npm pack did not return a tarball filename.');
    } else {
      const tarballPath = join(packDir, tarballName);
      writeFileSync(join(installDir, 'package.json'), JSON.stringify({
        private: true,
        type: 'module'
      }, null, 2));

      const installResult = runNpm([
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        '--cache',
        npmCacheDir,
        tarballPath
      ], { cwd: installDir });
      if (requireSuccess('npm install packed tarball', installResult)) {
        const importResult = runNode([
          '--input-type=module',
          '-e',
          "const pkg = await import('@henkey/postgres-mcp-server'); console.log(`${pkg.PACKAGE_VERSION}:${pkg.allTools.length}`);"
        ], { cwd: installDir });
        if (requireSuccess('import installed package', importResult)) {
          requireIncludes('installed package import output', importResult.stdout.trim(), `${packageJson.version}:18`);
        }

        const versionResult = runInstalledBin(['--version'], { cwd: installDir });
        if (requireSuccess('installed postgres-mcp --version', versionResult)) {
          requireIncludes('installed postgres-mcp --version output', versionResult.stdout.trim(), packageJson.version);
        }

        const helpResult = runInstalledBin(['--help'], { cwd: installDir });
        if (requireSuccess('installed postgres-mcp --help', helpResult)) {
          requireIncludes('installed postgres-mcp --help output', helpResult.stdout, '--allowed-connection-target');
        }
      }
    }
  }
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

if (errors.length > 0) {
  console.error('Packed install verification failed:');
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log('Packed install verified from generated tarball.');
