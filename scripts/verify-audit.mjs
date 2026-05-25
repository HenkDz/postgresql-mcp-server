import { spawnSync } from 'node:child_process';

const command = process.env.npm_execpath ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = process.env.npm_execpath
  ? [process.env.npm_execpath, 'audit', '--omit=dev', '--audit-level=moderate', '--json', '--cache', '.npm-cache']
  : ['audit', '--omit=dev', '--audit-level=moderate', '--json', '--cache', '.npm-cache'];

const result = spawnSync(command, args, {
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024
});

let auditReport;
try {
  auditReport = result.stdout ? JSON.parse(result.stdout) : undefined;
} catch {
  auditReport = undefined;
}

if (result.status !== 0) {
  console.error('Production dependency audit failed.');
  if (auditReport?.vulnerabilities) {
    for (const [name, vulnerability] of Object.entries(auditReport.vulnerabilities)) {
      console.error(`- ${name}: ${vulnerability.severity}`);
    }
  } else {
    if (result.stdout) {
      console.error(result.stdout);
    }
    if (result.stderr) {
      console.error(result.stderr);
    }
  }
  process.exit(result.status ?? 1);
}

const total = auditReport?.metadata?.vulnerabilities?.total;
if (total !== 0) {
  console.error(`Production dependency audit expected 0 vulnerabilities, got ${total}.`);
  process.exit(1);
}

console.log('Production dependency audit verified with 0 vulnerabilities.');
