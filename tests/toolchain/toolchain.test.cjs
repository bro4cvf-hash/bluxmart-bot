'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const root = path.resolve(__dirname, '..', '..');

/** @param {string} relativePath @returns {any} */
function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
}

const manifest = readJson('package.json');
const lock = readJson('package-lock.json');
const tsconfig = readJson('tsconfig.json');
const testConfig = readJson('tsconfig.test.json');

/** @param {Record<string, string>} dependencies */
function assertExactVersions(dependencies) {
  for (const [name, version] of Object.entries(dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, `${name} must be exactly pinned`);
  }
}

test('manifest targets the Node 24 LTS toolchain', () => {
  assert.equal(manifest.private, true);
  assert.equal(manifest.packageManager, 'npm@11.19.0');
  assert.equal(manifest.engines.node, '>=24.0.0 <25.0.0');
  assert.equal(manifest.engines.npm, '>=11.0.0 <12.0.0');
  assertExactVersions(manifest.dependencies);
  assertExactVersions(manifest.devDependencies);
});

test('lockfile is reproducible and mirrors direct dependencies', () => {
  assert.equal(lock.lockfileVersion, 3);
  assert.equal(lock.packages[''].name, manifest.name);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[''].devDependencies, manifest.devDependencies);
});

test('runtime dependency majors remain compatible with the live-sync baseline', () => {
  assert.match(manifest.dependencies['discord.js'], /^14\./);
  assert.match(manifest.dependencies.express, /^4\./);
  assert.equal(manifest.type, 'commonjs');
});

test('verification scripts cover check, tests, build, and clean lifecycle', () => {
  assert.equal(manifest.scripts.prebuild, 'node scripts/clean.cjs');
  assert.match(manifest.scripts.build, /^tsc -p tsconfig\.json --noEmitOnError/);
  assert.match(manifest.scripts.check, /--noEmit/);
  assert.match(manifest.scripts.check, /check:tests/);
  assert.equal(manifest.scripts.test, 'node --test tests/toolchain/*.test.cjs');
  assert.equal(manifest.scripts.tests, 'npm test');
  assert.equal(manifest.scripts.verify, 'npm run check && npm run tests && npm run build');

  const cleanSource = fs.readFileSync(path.join(root, 'scripts', 'clean.cjs'), 'utf8');
  assert.match(cleanSource, /fs\.rmSync/);
  assert.match(cleanSource, /recursive:\s*true/);
  assert.match(cleanSource, /force:\s*true/);
});

test('compiler safety is explicit for production and toolchain code', () => {
  assert.equal(tsconfig.compilerOptions.strict, true);
  assert.equal(tsconfig.compilerOptions.noEmitOnError, true);
  assert.equal(tsconfig.compilerOptions.rootDir, 'src');
  assert.equal(testConfig.extends, './tsconfig.json');
  assert.equal(testConfig.compilerOptions.noEmit, true);
  assert.equal(testConfig.compilerOptions.noEmitOnError, true);
  assert.deepEqual(testConfig.include, ['tests/toolchain/**/*.cjs']);
});

test('CI uses the lockfile on Node 24 without secrets or live configuration', () => {
  const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(workflow, /node-version:\s*['"]?24\.x['"]?/);
  assert.match(workflow, /run:\s*npm ci/);
  assert.match(workflow, /npm run verify/);
  assert.doesNotMatch(workflow, /secrets\./);
  assert.doesNotMatch(workflow, /DISCORD_TOKEN|CLIENT_ID|GUILD_ID/);
});
