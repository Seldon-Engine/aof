import { execSync } from 'node:child_process';
import { mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2];
if (!version) {
  console.error('Usage: node scripts/build-tarball.mjs <version>');
  process.exit(1);
}

// --- Version coherence check ---
// Ensure package.json and openclaw.plugin.json agree with the requested version.
// This catches cases where the version bump was skipped (e.g. release-it --no-npm).
const tagVersion = version.replace(/^v/, '');
const pkgRoot = JSON.parse(readFileSync('package.json', 'utf8'));
const pluginRoot = JSON.parse(readFileSync('openclaw.plugin.json', 'utf8'));

const mismatches = [];
if (pkgRoot.version !== tagVersion) {
  mismatches.push(`package.json has "${pkgRoot.version}", expected "${tagVersion}"`);
}
if (pluginRoot.version !== tagVersion) {
  mismatches.push(`openclaw.plugin.json has "${pluginRoot.version}", expected "${tagVersion}"`);
}
if (mismatches.length > 0) {
  console.error(`Version mismatch — tarball version ${tagVersion} does not match source files:`);
  for (const m of mismatches) console.error(`  - ${m}`);
  console.error('Ensure the release process bumps all version files before building the tarball.');
  process.exit(1);
}

const staging = '.release-staging';
mkdirSync(staging, { recursive: true });

// Production files — mirrors "files" field in package.json + package.json itself
const required = [
  'dist',
  'prompts',
  'skills',
  'index.ts',
  'openclaw.plugin.json',
  'README.md',
  'package.json',
  'package-lock.json',
];

const optional = ['LICENSE'];

for (const f of required) {
  if (!existsSync(f)) {
    console.error(`Required file/directory missing: ${f}`);
    execSync(`rm -rf ${staging}`);
    process.exit(1);
  }
  cpSync(f, join(staging, f), { recursive: true });
}

for (const f of optional) {
  try {
    cpSync(f, join(staging, f), { recursive: true });
  } catch {
    // Optional file missing — skip silently
  }
}

// Strip dev-only fields from staged package.json so end-user npm ci
// doesn't choke on the "prepare" script (simple-git-hooks isn't shipped).
const pkgPath = join(staging, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
delete pkg.scripts?.prepare;
delete pkg['simple-git-hooks'];
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// OpenClaw's plugin loader resolves the manifest relative to the symlink
// target (~/.openclaw/extensions/aof → $INSTALL_DIR/dist/). The root-level
// manifest points to "dist/plugin.js" which is wrong from inside dist/.
// Write a dist-local copy with main=plugin.js. Mirrors scripts/deploy.sh.
const distManifest = JSON.parse(readFileSync(join(staging, 'openclaw.plugin.json'), 'utf8'));
distManifest.main = 'plugin.js';
writeFileSync(
  join(staging, 'dist', 'openclaw.plugin.json'),
  JSON.stringify(distManifest, null, 2) + '\n',
);

const tarball = `aof-${version}.tar.gz`;
execSync(`tar -czf ${tarball} -C ${staging} .`);
execSync(`rm -rf ${staging}`);
console.log(`Created ${tarball}`);
