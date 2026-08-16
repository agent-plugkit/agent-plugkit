#!/usr/bin/env tsx
/// <reference types="node" />

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface PackFile {
  path: string;
  mode: number;
}

interface PackResult {
  filename: string;
  files: PackFile[];
}

function assertInstalledCli(consumerRoot: string, phase: string, expectedVersion: string): void {
  const installedBin = join(
    consumerRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'agent-plugkit.cmd' : 'agent-plugkit',
  );
  const installedVersion = spawnSync(installedBin, ['--version'], { encoding: 'utf-8' });
  assert.equal(
    installedVersion.status,
    0,
    `${phase} CLI version failed:\n${installedVersion.stdout || ''}${installedVersion.stderr || ''}`,
  );
  assert.equal(installedVersion.stdout.trim(), expectedVersion);

  const installedHelp = spawnSync(installedBin, ['--help'], { encoding: 'utf-8' });
  assert.equal(
    installedHelp.status,
    0,
    `${phase} CLI help failed:\n${installedHelp.stdout || ''}${installedHelp.stderr || ''}`,
  );
  assert.match(installedHelp.stdout, /agent-plugkit/);
}

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const monorepoRoot = join(cliRoot, '..', '..');
const expectedCliVersion = (JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf-8')) as {
  version: string;
}).version;
const distDir = join(cliRoot, 'dist');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const tsxBin = join(monorepoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const cliPath = join(cliRoot, 'src', 'cli.ts');

assert.equal(
  readFileSync(join(cliRoot, 'LICENSE'), 'utf-8'),
  readFileSync(join(monorepoRoot, 'LICENSE'), 'utf-8'),
  'CLI package LICENSE must stay byte-identical to the monorepo license',
);

assert.equal(existsSync(join(distDir, 'cli.js')), true, 'package test requires a completed build');
assert.equal(
  existsSync(join(distDir, '.npmignore')),
  true,
  'build must emit dist/.npmignore so local release artifacts stay outside the npm package',
);

const releaseFixtureRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-release-'));
const releasePluginRoot = join(releaseFixtureRoot, 'plugins', 'fixture');
mkdirSync(join(releasePluginRoot, 'skills', 'fixture'), { recursive: true });
writeFileSync(
  join(releaseFixtureRoot, 'marketplace.yaml'),
  'name: fixture-marketplace\ndescription: Package isolation fixture\norganization: Fixture Team\n',
);
writeFileSync(
  join(releasePluginRoot, 'plugin.yaml'),
  `name: fixture
version: "0.1.0"
description: "Package isolation fixture"
author:
  name: "Fixture Team"
category: tooling
tags: []
components:
  skills:
    - name: fixture
      path: skills/fixture
      description: "Fixture skill"
`,
);
writeFileSync(
  join(releasePluginRoot, 'skills', 'fixture', 'SKILL.md'),
  '---\nname: fixture\ndescription: "Fixture skill."\n---\n\n# Fixture\n',
);

for (const args of [['build', '--all'], ['index'], ['validate', '--all']]) {
  const result = spawnSync(process.execPath, [tsxBin, cliPath, '--root', releaseFixtureRoot, ...args], {
    cwd: cliRoot,
    encoding: 'utf-8',
  });
  assert.equal(
    result.status,
    0,
    `${args.join(' ')} fixture failed:\n${result.stdout || ''}${result.stderr || ''}`,
  );
}

const release = spawnSync(
  process.execPath,
  [tsxBin, cliPath, '--root', releaseFixtureRoot, 'release-local'],
  {
    cwd: cliRoot,
    encoding: 'utf-8',
  },
);
assert.equal(
  release.status,
  0,
  `release-local fixture failed:\n${release.stdout || ''}${release.stderr || ''}`,
);

const releaseDir = join(releaseFixtureRoot, 'dist', 'release');
assert.equal(existsSync(join(releaseDir, 'release-manifest.json')), true);
assert.equal(
  existsSync(join(releaseDir, '.github', 'plugin', 'marketplace.json')),
  true,
);
assert.equal(
  existsSync(join(releaseDir, '.cursor-plugin', 'marketplace.json')),
  true,
);
assert.equal(
  readdirSync(join(releaseFixtureRoot, 'dist')).some((name) => /-release-.*\.tar\.gz$/.test(name)),
  true,
  'release-local must create a local archive before npm package isolation is checked',
);
mkdirSync(join(releaseDir, 'plugins', 'fixture'), { recursive: true });
writeFileSync(join(releaseDir, 'plugins', 'fixture', 'server.js'), 'export {};\n');

const packageFixtureRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-package-'));
cpSync(distDir, join(packageFixtureRoot, 'dist'), { recursive: true });
cpSync(join(cliRoot, 'README.md'), join(packageFixtureRoot, 'README.md'));
cpSync(join(cliRoot, 'LICENSE'), join(packageFixtureRoot, 'LICENSE'));
cpSync(join(cliRoot, 'package.json'), join(packageFixtureRoot, 'package.json'));
mkdirSync(join(packageFixtureRoot, 'dist', 'release'), { recursive: true });
writeFileSync(join(packageFixtureRoot, 'dist', 'release', 'should-not-pack.txt'), 'fixture\n');
writeFileSync(join(packageFixtureRoot, 'dist', 'fixture-release-archive.tar.gz'), 'fixture\n');

const pack = spawnSync(
  npmCommand,
  ['pack', '--dry-run', '--json', '--ignore-scripts', '--silent'],
  {
    cwd: packageFixtureRoot,
    encoding: 'utf-8',
  },
);

assert.equal(pack.status, 0, `npm pack failed:\n${pack.stdout || ''}${pack.stderr || ''}`);

const results = JSON.parse(pack.stdout) as PackResult[];
assert.equal(results.length, 1, 'npm pack should return one package result');
const paths = results[0].files.map((file) => file.path);

assert.ok(paths.includes('dist/cli.js'), 'npm package must keep the compiled CLI');
assert.ok(
  paths.includes('dist/commands/import-skill.js'),
  'npm package must keep compiled command modules',
);
assert.equal(
  paths.some((path) => path.startsWith('dist/release/')),
  false,
  'npm package must exclude dist/release/**',
);
assert.equal(
  paths.some((path) => /^dist\/.*-release-.*\.tar\.gz$/.test(path)),
  false,
  'npm package must exclude local release archives',
);
assert.equal(
  paths.some((path) => path.startsWith('marketplace/')),
  false,
  'npm package must not contain the marketplace workspace',
);

const workspacePackRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-workspace-pack-'));
rmSync(distDir, { recursive: true, force: true });

const workspacePack = spawnSync(
  npmCommand,
  [
    'pack',
    '--workspace',
    'agent-plugkit',
    '--silent',
    '--pack-destination',
    workspacePackRoot,
  ],
  {
    cwd: monorepoRoot,
    encoding: 'utf-8',
  },
);

assert.equal(
  workspacePack.status,
  0,
  `fresh workspace pack failed:\n${workspacePack.stdout || ''}${workspacePack.stderr || ''}`,
);
assert.equal(
  existsSync(join(distDir, 'cli.js')),
  true,
  'normal npm pack must run the CLI workspace prepack build',
);

const tarballName = workspacePack.stdout
  .trim()
  .split(/\r?\n/)
  .findLast((line) => line.endsWith('.tgz'));
assert.ok(tarballName, `workspace pack did not report a tarball:\n${workspacePack.stdout || ''}`);
const tarballPath = join(workspacePackRoot, tarballName);
assert.equal(existsSync(tarballPath), true, 'workspace pack must create a real tarball');

const workspacePackListing = spawnSync(
  npmCommand,
  ['pack', '--workspace', 'agent-plugkit', '--dry-run', '--json', '--ignore-scripts', '--silent'],
  {
    cwd: monorepoRoot,
    encoding: 'utf-8',
  },
);
assert.equal(
  workspacePackListing.status,
  0,
  `workspace pack listing failed:\n${workspacePackListing.stdout || ''}${workspacePackListing.stderr || ''}`,
);
const workspaceResults = JSON.parse(workspacePackListing.stdout) as PackResult[];
assert.equal(workspaceResults.length, 1, 'workspace pack should return one package result');
const workspaceCli = workspaceResults[0].files.find((file) => file.path === 'dist/cli.js');
assert.ok(workspaceCli, 'prepack must rebuild dist/cli.js from a fresh workspace');
assert.equal(workspaceCli.mode, 0o755, 'packed CLI bin must retain executable mode 0755');

const consumerRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-consumer-'));
const consumerCacheRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-consumer-cache-'));
writeFileSync(join(consumerRoot, 'package.json'), '{"private":true}\n');
const onlineInstall = spawnSync(
  npmCommand,
  [
    'install',
    '--cache',
    consumerCacheRoot,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    tarballPath,
  ],
  {
    cwd: consumerRoot,
    encoding: 'utf-8',
  },
);
assert.equal(
  onlineInstall.status,
  0,
  `packed CLI online install failed:\n${onlineInstall.stdout || ''}${onlineInstall.stderr || ''}`,
);
assertInstalledCli(consumerRoot, 'online-installed', expectedCliVersion);

assert.equal(
  existsSync(join(consumerRoot, 'package-lock.json')),
  true,
  'online install must create the lockfile used by the offline reinstall',
);
rmSync(join(consumerRoot, 'node_modules'), { recursive: true, force: true });

const offlineInstall = spawnSync(
  npmCommand,
  [
    'ci',
    '--cache',
    consumerCacheRoot,
    '--offline',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ],
  {
    cwd: consumerRoot,
    encoding: 'utf-8',
  },
);
assert.equal(
  offlineInstall.status,
  0,
  `packed CLI offline reinstall failed:\n${offlineInstall.stdout || ''}${offlineInstall.stderr || ''}`,
);
assertInstalledCli(consumerRoot, 'offline-reinstalled', expectedCliVersion);

console.log(
  '✓ CLI package is isolated, rebuilt by prepack, installable normally, and reinstallable offline',
);
