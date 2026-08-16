#!/usr/bin/env tsx
/// <reference types="node" />

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'jsonc-parser';
import {
  executeMarketplaceRegistration,
  inspectMarketplaceRegistration,
  normalizeMarketplaceSource,
} from '../src/application/marketplace-registration.js';
import type { AgentTargetId } from '../src/application/marketplace-registration-contract.js';
import type {
  ProcessRequest,
  ProcessResult,
  ProcessRunner,
} from '../src/infrastructure/process-runner.js';
import { systemProcessRunner } from '../src/infrastructure/process-runner.js';
import {
  inspectVscodeUserSettings,
  resolveVscodeUserSettingsPath,
  updateVscodeMarketplaceSettings,
} from '../src/infrastructure/vscode-user-settings.js';
import {
  parseTargetSelection,
  runInstallRepo,
} from '../src/commands/install-repo.js';

function expectThrows(fn: () => unknown, pattern: RegExp): void {
  assert.throws(fn, pattern);
}

function snapshotDirectory(root: string, current = root): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    const relativePath = path.slice(root.length + 1);
    if (entry.isDirectory()) {
      Object.assign(snapshot, snapshotDirectory(root, path));
    } else if (entry.isFile()) {
      snapshot[relativePath] = readFileSync(path).toString('base64');
    } else {
      snapshot[relativePath] = `<${entry.isSymbolicLink() ? 'symlink' : 'other'}>`;
    }
  }
  return snapshot;
}

let externalReplacementSequence = 0;

function atomicallyReplaceFromExternalNode(
  settingsPath: string,
  bytes: Buffer,
  mode: number,
): void {
  const replacementPath = join(
    dirname(settingsPath),
    `.settings.external-${process.pid}-${externalReplacementSequence += 1}.tmp`,
  );
  writeFileSync(replacementPath, bytes);
  chmodSync(replacementPath, mode);
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      "require('node:fs').renameSync(process.argv[1], process.argv[2])",
      replacementPath,
      settingsPath,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
}

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const monorepoRoot = join(cliRoot, '..', '..');
const cliPath = join(cliRoot, 'src/cli.ts');
const tsxBin = join(monorepoRoot, 'node_modules/tsx/dist/cli.mjs');

async function testSourceNormalization(): Promise<void> {
  const baseDir = mkdtempSync(join(tmpdir(), 'agent-plugkit-install-source-'));
  const localDir = join(baseDir, 'local-marketplace');
  mkdirSync(localDir);
  const canonicalLocalDir = realpathSync(localDir);

  const local = normalizeMarketplaceSource('./local-marketplace', { baseDir });
  assert.deepEqual(local, {
    kind: 'local',
    input: './local-marketplace',
    displayValue: canonicalLocalDir,
    clientValue: canonicalLocalDir,
    vscodeValue: pathToFileURL(canonicalLocalDir).href,
    localPath: canonicalLocalDir,
  });

  assert.deepEqual(normalizeMarketplaceSource('owner/repo', { baseDir }), {
    kind: 'git',
    input: 'owner/repo',
    displayValue: 'owner/repo',
    clientValue: 'owner/repo',
    vscodeValue: 'owner/repo',
  });
  assert.equal(
    normalizeMarketplaceSource('https://github.com/owner/repo.git', { baseDir }).kind,
    'git',
  );
  assert.equal(
    normalizeMarketplaceSource('ssh://git@github.com/owner/repo.git', { baseDir }).kind,
    'git',
  );
  assert.equal(
    normalizeMarketplaceSource('git@github.com:owner/repo.git', { baseDir }).kind,
    'git',
  );

  expectThrows(
    () => normalizeMarketplaceSource('./missing-marketplace', { baseDir }),
    /本地路径不存在/,
  );
  expectThrows(
    () => normalizeMarketplaceSource('./does-not-exist/..', { baseDir }),
    /本地路径不存在/,
  );
  expectThrows(
    () => normalizeMarketplaceSource('./does-not-exist/../local-marketplace', { baseDir }),
    /本地路径不存在/,
  );
  expectThrows(
    () => normalizeMarketplaceSource('~/does-not-exist/..', { baseDir, homeDir: baseDir }),
    /本地路径不存在/,
  );
  expectThrows(() => normalizeMarketplaceSource('ambiguous', { baseDir }), /无法识别来源/);
  expectThrows(
    () => normalizeMarketplaceSource('https://token@example.com/owner/repo.git', { baseDir }),
    /内嵌凭据/,
  );
  expectThrows(
    () => normalizeMarketplaceSource('http://example.com/owner/repo.git', { baseDir }),
    /只接受 HTTPS/,
  );
  expectThrows(() => normalizeMarketplaceSource('--danger', { baseDir }), /不能以 - 开头/);
  expectThrows(
    () => normalizeMarketplaceSource('git@github.com:owner/repo\u001b[2J.git', { baseDir }),
    /控制字符/,
  );
  expectThrows(
    () => normalizeMarketplaceSource('https://github.com/owner/repo\u007f.git', { baseDir }),
    /控制字符/,
  );
  expectThrows(
    () => normalizeMarketplaceSource('ssh://git@github.com/owner/repo\u0085.git', { baseDir }),
    /控制字符/,
  );
  for (const dotSegmentSource of ['missing/..', 'missing/.', 'owner/..', 'owner/.']) {
    expectThrows(
      () => normalizeMarketplaceSource(dotSegmentSource, { baseDir }),
      /不能是 \. 或 \.\./,
    );
  }
  for (const encodedControlSource of [
    'https://github.com/owner/repo%0a.git',
    'https://github.com/owner/repo%C2%85.git',
    'ssh://git@github.com/owner/repo%1b.git',
    'git@github.com:owner/repo%1b.git',
  ]) {
    expectThrows(
      () => normalizeMarketplaceSource(encodedControlSource, { baseDir }),
      /控制字符/,
    );
  }

  const controlPath = join(baseDir, 'marketplace\u001b[2J');
  mkdirSync(controlPath);
  expectThrows(
    () => normalizeMarketplaceSource(controlPath, { baseDir }),
    /控制字符/,
  );
  expectThrows(
    () => normalizeMarketplaceSource('.', { baseDir: controlPath }),
    /控制字符/,
  );

  const localFile = join(baseDir, 'marketplace.json');
  writeFileSync(localFile, '{}\n');
  expectThrows(
    () => normalizeMarketplaceSource('./marketplace.json', { baseDir }),
    /不是目录/,
  );

  mkdirSync(join(baseDir, '.claude-plugin'));
  writeFileSync(join(baseDir, '.claude-plugin/marketplace.json'), '{}\n');
  const missingSegmentRunner = new FakeProcessRunner(() => completedProcess());
  await assert.rejects(
    inspectMarketplaceRegistration('./does-not-exist/..', {
        baseDir,
        targetIds: ['claude'],
        runtime: { processRunner: missingSegmentRunner },
      }),
    /本地路径不存在/,
  );
  assert.deepEqual(missingSegmentRunner.requests, []);
  for (const rejectedSource of [
    'missing/..',
    'owner/.',
    'https://github.com/owner/repo%0a.git',
    'ssh://git@github.com/owner/repo%1b.git',
  ]) {
    await assert.rejects(
      inspectMarketplaceRegistration(rejectedSource, {
        baseDir,
        targetIds: ['claude'],
        runtime: { processRunner: missingSegmentRunner },
      }),
      /控制字符|不能是 \. 或 \.\./,
    );
  }
  assert.deepEqual(missingSegmentRunner.requests, []);
}

async function testVscodeSettingsUpdate(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agent-plugkit-vscode-settings-'));
  const settingsPath = join(root, 'Code/User/settings.json');

  const created = updateVscodeMarketplaceSettings({
    settingsPath,
    source: 'file:///tmp/local-marketplace',
  });
  assert.equal(created.status, 'completed');
  assert.equal(created.changed, true);
  assert.deepEqual(parse(readFileSync(settingsPath, 'utf8')), {
    'chat.plugins.enabled': true,
    'chat.plugins.marketplaces': ['file:///tmp/local-marketplace'],
  });
  assert.equal(statSync(settingsPath).mode & 0o777, 0o600);

  writeFileSync(
    settingsPath,
    `{
  // unrelated comment stays
  "editor.fontSize": 14,
  "chat.plugins.enabled": false,
  "chat.plugins.marketplaces": [
    // keep marketplace comment
    "owner/repo",
    "owner/repo",
  ],
}
`,
  );
  chmodSync(settingsPath, 0o640);
  const updated = updateVscodeMarketplaceSettings({
    settingsPath,
    source: 'owner/repo',
  });
  assert.equal(updated.status, 'completed');
  assert.equal(updated.changed, true);
  const updatedBytes = readFileSync(settingsPath, 'utf8');
  const updatedValue = parse(updatedBytes) as Record<string, unknown>;
  assert.equal(updatedValue['chat.plugins.enabled'], true);
  assert.deepEqual(updatedValue['chat.plugins.marketplaces'], ['owner/repo']);
  assert.match(updatedBytes, /unrelated comment stays/);
  assert.match(updatedBytes, /keep marketplace comment/);
  assert.match(updatedBytes, /"editor\.fontSize": 14/);
  assert.match(updatedBytes, /,\s*\n}/);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o640);

  const firstDuplicateComment = `{
  "chat.plugins.enabled": true,
  "chat.plugins.marketplaces": [
    "owner/repo", // important first duplicate
    "owner/repo",
  ],
}
`;
  writeFileSync(settingsPath, firstDuplicateComment);
  const firstDuplicateCommentResult = updateVscodeMarketplaceSettings({
    settingsPath,
    source: 'owner/repo',
  });
  assert.equal(firstDuplicateCommentResult.status, 'failed');
  assert.match(firstDuplicateCommentResult.message, /注释/);
  assert.equal(readFileSync(settingsPath, 'utf8'), firstDuplicateComment);

  const lastDuplicateComment = `{
  "chat.plugins.enabled": true,
  "chat.plugins.marketplaces": [
    "owner/repo",
    "owner/repo", // important last duplicate
  ],
}
`;
  writeFileSync(settingsPath, lastDuplicateComment);
  const lastDuplicateCommentResult = updateVscodeMarketplaceSettings({
    settingsPath,
    source: 'owner/repo',
  });
  assert.equal(lastDuplicateCommentResult.status, 'failed');
  assert.match(lastDuplicateCommentResult.message, /注释/);
  assert.equal(readFileSync(settingsPath, 'utf8'), lastDuplicateComment);

  const independentComment = `{
  "chat.plugins.enabled": true,
  "chat.plugins.marketplaces": [
    // keep independent comment
    "other/repo",
    "other/repo",
    "owner/repo",
  ],
}
`;
  writeFileSync(settingsPath, independentComment);
  const independentCommentResult = updateVscodeMarketplaceSettings({
    settingsPath,
    source: 'owner/repo',
  });
  assert.equal(independentCommentResult.status, 'completed');
  const independentCommentBytes = readFileSync(settingsPath, 'utf8');
  assert.match(independentCommentBytes, /keep independent comment/);
  assert.deepEqual(
    (parse(independentCommentBytes) as Record<string, unknown>)[
      'chat.plugins.marketplaces'
    ],
    ['other/repo', 'owner/repo'],
  );

  const idempotent = updateVscodeMarketplaceSettings({ settingsPath, source: 'owner/repo' });
  assert.equal(idempotent.status, 'completed');
  assert.equal(idempotent.changed, false);
  assert.equal(readFileSync(settingsPath, 'utf8'), independentCommentBytes);

  const duplicateEnabled = `{
  "chat.plugins.enabled": true,
  "chat.plugins.enabled": false,
  "chat.plugins.marketplaces": ["owner/repo"],
}
`;
  writeFileSync(settingsPath, duplicateEnabled);
  const duplicateEnabledResult = updateVscodeMarketplaceSettings({
    settingsPath,
    source: 'owner/repo',
  });
  assert.equal(duplicateEnabledResult.status, 'failed');
  assert.match(duplicateEnabledResult.message, /重复的 chat\.plugins\.enabled/);
  assert.equal(readFileSync(settingsPath, 'utf8'), duplicateEnabled);

  const duplicateMarketplaces = `{
  "chat.plugins.enabled": true,
  "chat.plugins.marketplaces": ["other/repo"],
  "chat.plugins.marketplaces": ["owner/repo"],
}
`;
  writeFileSync(settingsPath, duplicateMarketplaces);
  const duplicateMarketplacesResult = updateVscodeMarketplaceSettings({
    settingsPath,
    source: 'owner/repo',
  });
  assert.equal(duplicateMarketplacesResult.status, 'failed');
  assert.match(duplicateMarketplacesResult.message, /重复的 chat\.plugins\.marketplaces/);
  assert.equal(readFileSync(settingsPath, 'utf8'), duplicateMarketplaces);

  writeFileSync(
    settingsPath,
    `{
  // append without losing this comment
  "chat.plugins.enabled": true,
  "chat.plugins.marketplaces": ["first/repo",],
}
`,
  );
  const appended = updateVscodeMarketplaceSettings({
    settingsPath,
    source: 'second/repo',
  });
  assert.equal(appended.status, 'completed');
  const appendedBytes = readFileSync(settingsPath, 'utf8');
  assert.deepEqual(
    (parse(appendedBytes) as Record<string, unknown>)['chat.plugins.marketplaces'],
    ['first/repo', 'second/repo'],
  );
  assert.match(appendedBytes, /append without losing this comment/);

  writeFileSync(settingsPath, '{ malformed jsonc');
  const malformedBefore = readFileSync(settingsPath, 'utf8');
  const malformed = updateVscodeMarketplaceSettings({ settingsPath, source: 'owner/repo' });
  assert.equal(malformed.status, 'failed');
  assert.match(malformed.message, /不是合法 JSONC/);
  assert.equal(readFileSync(settingsPath, 'utf8'), malformedBefore);

  const invalidUtf8 = Buffer.concat([
    Buffer.from('{\n  // invalid byte: ', 'utf8'),
    Buffer.from([0xff]),
    Buffer.from('\n  "editor.fontSize": 14,\n}\n', 'utf8'),
  ]);
  writeFileSync(settingsPath, invalidUtf8);
  chmodSync(settingsPath, 0o640);
  const invalidUtf8Result = updateVscodeMarketplaceSettings({
    settingsPath,
    source: 'owner/repo',
  });
  assert.equal(invalidUtf8Result.status, 'failed');
  assert.match(invalidUtf8Result.message, /UTF-8/);
  assert.deepEqual(readFileSync(settingsPath), invalidUtf8);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o640);

  writeFileSync(settingsPath, '{"editor.fontSize": 14}\n');
  const concurrentBytes = '{"concurrent": true}\n';
  const conflict = updateVscodeMarketplaceSettings(
    { settingsPath, source: 'owner/repo' },
    { beforeRevisionCheck: () => writeFileSync(settingsPath, concurrentBytes) },
  );
  assert.equal(conflict.status, 'failed');
  assert.match(conflict.message, /并发变化/);
  assert.equal(readFileSync(settingsPath, 'utf8'), concurrentBytes);

  const renameWindowOriginal = '{"editor.fontSize": 15}\n';
  const renameWindowConcurrent = '{"concurrentDuringRename": true}\n';
  writeFileSync(settingsPath, renameWindowOriginal);
  const renameWindowConflict = updateVscodeMarketplaceSettings(
    { settingsPath, source: 'owner/repo' },
    {
      rename: (from, to) => {
        // In-place writes remain observable through the guard descriptor and are restored.
        writeFileSync(settingsPath, renameWindowConcurrent);
        renameSync(from, to);
      },
    },
  );
  assert.equal(renameWindowConflict.status, 'failed');
  assert.match(renameWindowConflict.message, /revision 检查与原子替换之间发生同 inode 并发变化/);
  assert.match(renameWindowConflict.message, /最佳努力.*TD-001/);
  assert.equal(readFileSync(settingsPath, 'utf8'), renameWindowConcurrent);
  assert.deepEqual(
    readdirSync(join(root, 'Code/User')).filter((name) => name.includes('agent-plugkit')),
    [],
  );

  const postCommitOriginal = Buffer.from('{"editor.fontSize": 15}\n');
  const postCommitExternal = Buffer.from('{"postCommitExternal": true}\n');
  writeFileSync(settingsPath, postCommitOriginal);
  chmodSync(settingsPath, 0o640);
  const postCommitConflict = updateVscodeMarketplaceSettings(
    { settingsPath, source: 'owner/repo' },
    {
      rename: (from, to) => {
        renameSync(from, to);
        atomicallyReplaceFromExternalNode(settingsPath, postCommitExternal, 0o604);
      },
    },
  );
  assert.equal(postCommitConflict.status, 'failed');
  assert.match(postCommitConflict.message, /原子替换后发生并发变化/);
  assert.deepEqual(readFileSync(settingsPath), postCommitExternal);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o604);
  assert.deepEqual(
    readdirSync(join(root, 'Code/User')).filter((name) => name.includes('agent-plugkit')),
    [],
  );

  const recoveryWindowOriginal = Buffer.from('{"editor.fontSize": 16}\n');
  const recoveryGuardBytes = Buffer.from('{"guardConcurrent": true}\n');
  const recoveryLaterBytes = Buffer.from('{"laterExternal": true}\n');
  writeFileSync(settingsPath, recoveryWindowOriginal);
  chmodSync(settingsPath, 0o640);
  const acceptedRecoveryRace = updateVscodeMarketplaceSettings(
    { settingsPath, source: 'owner/repo' },
    {
      rename: (from, to) => {
        writeFileSync(settingsPath, recoveryGuardBytes);
        renameSync(from, to);
      },
      beforeRecoveryRename: () => {
        atomicallyReplaceFromExternalNode(settingsPath, recoveryLaterBytes, 0o604);
      },
    },
  );
  assert.equal(acceptedRecoveryRace.status, 'failed');
  assert.match(acceptedRecoveryRace.message, /最佳努力.*TD-001/);
  // TD-001 explicitly accepts that recovery's unconditional rename can overwrite the later inode.
  assert.deepEqual(readFileSync(settingsPath), recoveryGuardBytes);
  assert.equal(statSync(settingsPath).mode & 0o777, 0o640);
  assert.deepEqual(
    readdirSync(join(root, 'Code/User')).filter((name) => name.includes('agent-plugkit')),
    [],
  );

  const renameOriginal = '{"editor.fontSize": 17}\n';
  writeFileSync(settingsPath, renameOriginal);
  const renameFailure = updateVscodeMarketplaceSettings(
    { settingsPath, source: 'owner/repo' },
    { rename: () => { throw new Error('rename denied'); } },
  );
  assert.equal(renameFailure.status, 'failed');
  assert.match(renameFailure.message, /原子替换失败/);
  assert.equal(readFileSync(settingsPath, 'utf8'), renameOriginal);
  assert.deepEqual(
    readdirSync(join(root, 'Code/User')).filter((name) => name.includes('agent-plugkit')),
    [],
  );

  const permissionConflictOriginal = '{"editor.fontSize": 18}\n';
  const permissionConflictBytes = '{"permissionConflict": true}\n';
  writeFileSync(settingsPath, permissionConflictOriginal);
  const settingsParent = dirname(settingsPath);
  chmodSync(settingsParent, 0o700);
  const permissionConflict = updateVscodeMarketplaceSettings(
    { settingsPath, source: 'owner/repo' },
    {
      beforeRevisionCheck: () => {
        writeFileSync(settingsPath, permissionConflictBytes);
        chmodSync(settingsParent, 0o500);
      },
    },
  );
  chmodSync(settingsParent, 0o700);
  assert.equal(permissionConflict.status, 'failed');
  assert.match(permissionConflict.message, /并发变化/);
  assert.equal(readFileSync(settingsPath, 'utf8'), permissionConflictBytes);
  assert.deepEqual(
    readdirSync(settingsParent).filter((name) => name.includes('agent-plugkit')),
    [],
  );

  const cursorAliasRunner = new FakeProcessRunner(() => ({
    status: 'completed',
    exitCode: 0,
    stdout: 'Cursor command line interface',
    stderr: '',
  }));
  const aliasHome = mkdtempSync(join(tmpdir(), 'agent-plugkit-vscode-alias-'));
  const cursorAlias = await inspectVscodeUserSettings(cursorAliasRunner, {
    platform: 'linux',
    homeDir: aliasHome,
    env: {},
  });
  assert.equal(cursorAlias.status, 'unavailable');
  assert.match(cursorAlias.status === 'unavailable' ? cursorAlias.message : '', /Cursor/);

  const officialRunner = new FakeProcessRunner(() => ({
    status: 'completed',
    exitCode: 0,
    stdout: 'Visual Studio Code 1.100.0',
    stderr: '',
  }));
  const officialHome = mkdtempSync(join(tmpdir(), 'agent-plugkit-vscode-official-'));
  const official = await inspectVscodeUserSettings(officialRunner, {
    platform: 'linux',
    homeDir: officialHome,
    env: {},
  });
  assert.deepEqual(official, {
    status: 'ready',
    settingsPath: join(officialHome, '.config/Code/User/settings.json'),
  });
  assert.equal(
    resolveVscodeUserSettingsPath({
      platform: 'darwin',
      homeDir: '/Users/tester',
      env: {},
    }),
    '/Users/tester/Library/Application Support/Code/User/settings.json',
  );
  assert.equal(
    resolveVscodeUserSettingsPath({
      platform: 'linux',
      homeDir: '/home/tester',
      env: { XDG_CONFIG_HOME: '/custom/config' },
    }),
    '/custom/config/Code/User/settings.json',
  );
  assert.equal(
    resolveVscodeUserSettingsPath({
      platform: 'linux',
      homeDir: '/home/tester',
      env: { XDG_CONFIG_HOME: 'relative-config' },
    }),
    '/home/tester/.config/Code/User/settings.json',
  );
  assert.equal(
    resolveVscodeUserSettingsPath({
      platform: 'darwin',
      homeDir: 'relative-home',
      env: {},
    }),
    undefined,
  );
  assert.equal(
    resolveVscodeUserSettingsPath({
      platform: 'linux',
      homeDir: 'relative-home',
      env: { XDG_CONFIG_HOME: 'relative-config' },
    }),
    undefined,
  );
  assert.equal(
    resolveVscodeUserSettingsPath({
      platform: 'darwin',
      homeDir: '/Users/tester\u001b[2J',
      env: {},
    }),
    undefined,
  );
  assert.equal(
    resolveVscodeUserSettingsPath({
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      env: { APPDATA: 'C:\\Users\\tester\\AppData\\Roaming' },
    }),
    'C:\\Users\\tester\\AppData\\Roaming\\Code\\User\\settings.json',
  );
  assert.equal(
    resolveVscodeUserSettingsPath({
      platform: 'win32',
      homeDir: 'C:\\Users\\tester',
      env: { APPDATA: 'relative-appdata' },
    }),
    'C:\\Users\\tester\\AppData\\Roaming\\Code\\User\\settings.json',
  );

  const relativeSettingsRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-relative-settings-'));
  const previousCwd = process.cwd();
  process.chdir(relativeSettingsRoot);
  try {
    const relativeSettings = updateVscodeMarketplaceSettings({
      settingsPath: 'relative-home/Code/User/settings.json',
      source: 'owner/repo',
    });
    assert.equal(relativeSettings.status, 'failed');
    assert.match(relativeSettings.message, /绝对用户配置路径/);
    assert.equal(existsSync(join(relativeSettingsRoot, 'relative-home')), false);
  } finally {
    process.chdir(previousCwd);
  }
}

class FakeProcessRunner implements ProcessRunner {
  readonly requests: ProcessRequest[] = [];
  readonly #handler: (request: ProcessRequest) => ProcessResult;

  constructor(handler: (request: ProcessRequest) => ProcessResult) {
    this.#handler = handler;
  }

  run(request: ProcessRequest): ProcessResult {
    this.requests.push(request);
    return this.#handler(request);
  }
}

function completedProcess(): ProcessResult {
  return { status: 'completed', exitCode: 0, stdout: '', stderr: '' };
}

function writeRegistrationIndexes(root: string): void {
  for (const relativePath of [
    '.claude-plugin/marketplace.json',
    '.agents/plugins/marketplace.json',
    '.github/plugin/marketplace.json',
    '.cursor-plugin/marketplace.json',
    'marketplace.json',
  ]) {
    const path = join(root, relativePath);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{}\n');
  }
}

async function testRegistrationRegistry(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agent-plugkit-registration-'));
  writeRegistrationIndexes(root);
  const settingsPath = join(
    mkdtempSync(join(tmpdir(), 'agent-plugkit-registration-settings-')),
    'settings.json',
  );
  const sourceBefore = snapshotDirectory(root);
  const runner = new FakeProcessRunner((request) => {
    if (request.executable === 'codex') {
      return { status: 'missing', stdout: '', stderr: '', message: 'ENOENT' };
    }
    if (request.executable === 'copilot' && !request.args.includes('--help')) {
      return { status: 'failed', exitCode: 9, stdout: '', stderr: 'bad repo', message: 'exit 9' };
    }
    return completedProcess();
  });
  let vscodeWrites = 0;
  const vscodeSources: string[] = [];
  const runtime = {
    processRunner: runner,
    inspectVscode: () => ({ status: 'ready' as const, settingsPath }),
    updateVscode: (request: { source: string }) => {
      vscodeWrites += 1;
      vscodeSources.push(request.source);
      return { status: 'completed' as const, changed: true, settingsPath };
    },
  };
  const targetIds: AgentTargetId[] = ['claude', 'codex', 'copilot', 'vscode', 'cursor'];
  const inspection = await inspectMarketplaceRegistration(root, { targetIds, runtime });
  assert.deepEqual(
    inspection.targets.map((target) => [target.id, target.status]),
    [
      ['claude', 'ready'],
      ['codex', 'missing-cli'],
      ['copilot', 'ready'],
      ['vscode', 'ready'],
      ['cursor', 'manual-required'],
    ],
  );

  const report = await executeMarketplaceRegistration(inspection, { runtime });
  assert.equal(report.exitCode, 2);
  assert.deepEqual(
    report.results.map((result) => [result.id, result.status]),
    [
      ['claude', 'completed'],
      ['codex', 'missing-cli'],
      ['copilot', 'failed'],
      ['vscode', 'completed'],
      ['cursor', 'manual-required'],
    ],
  );
  assert.equal(vscodeWrites, 1);
  assert.deepEqual(vscodeSources, [pathToFileURL(realpathSync(root)).href]);
  assert.deepEqual(snapshotDirectory(root), sourceBefore);
  assert.deepEqual(
    runner.requests.map((request) => [request.executable, [...request.args], request.captureOutput]),
    [
      ['claude', ['plugin', 'marketplace', 'add', '--help'], true],
      ['codex', ['plugin', 'marketplace', 'add', '--help'], true],
      ['copilot', ['plugin', 'marketplace', 'add', '--help'], true],
      ['claude', ['plugin', 'marketplace', 'add', realpathSync(root)], false],
      ['copilot', ['plugin', 'marketplace', 'add', realpathSync(root)], false],
    ],
  );
  const cursorResult = report.results.find((result) => result.id === 'cursor');
  assert.match(cursorResult?.message ?? '', /Dashboard.*Plugins.*Add Marketplace.*Import from Repo/);
  assert.match(cursorResult?.message ?? '', /Team\/Enterprise.*管理员/);

  const failedVscodeInspection = await inspectMarketplaceRegistration(root, {
    targetIds: ['vscode'],
    runtime: {
      ...runtime,
      updateVscode: () => ({
        status: 'failed' as const,
        message: 'simulated conflict',
        settingsPath,
      }),
    },
  });
  const failedVscodeReport = await executeMarketplaceRegistration(failedVscodeInspection, {
    runtime: {
      ...runtime,
      updateVscode: () => ({
        status: 'failed' as const,
        message: 'simulated conflict',
        settingsPath,
      }),
    },
  });
  assert.equal(failedVscodeReport.results[0]?.status, 'failed');
  assert.match(failedVscodeReport.results[0]?.recovery ?? '', /最佳努力.*新 inode/);
  assert.doesNotMatch(failedVscodeReport.results[0]?.recovery ?? '', /原文件未被本次失败覆盖/);

  const missingCursorRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-cursor-index-'));
  const cursorInspection = await inspectMarketplaceRegistration(missingCursorRoot, {
    targetIds: ['cursor'],
    runtime,
  });
  assert.equal(cursorInspection.targets[0]?.status, 'failed');
  assert.match(cursorInspection.targets[0]?.message ?? '', /\.cursor-plugin\/marketplace\.json/);
  const cursorOnly = await executeMarketplaceRegistration(cursorInspection, { runtime });
  assert.equal(cursorOnly.exitCode, 1);
  assert.equal(cursorOnly.results[0]?.status, 'failed');
}

async function testVscodeSourceReadOnlyBoundary(): Promise<void> {
  const sourceRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-vscode-source-boundary-'));
  writeFileSync(join(sourceRoot, 'marketplace.json'), '{}\n');
  const nestedSettingsPath = join(
    sourceRoot,
    'Library/Application Support/Code/User/settings.json',
  );
  const sourceBefore = snapshotDirectory(sourceRoot);
  let writes = 0;
  const runtime = {
    processRunner: new FakeProcessRunner(() => completedProcess()),
    inspectVscode: () => ({ status: 'ready' as const, settingsPath: nestedSettingsPath }),
    updateVscode: () => {
      writes += 1;
      return {
        status: 'completed' as const,
        changed: true,
        settingsPath: nestedSettingsPath,
      };
    },
  };
  const inspection = await inspectMarketplaceRegistration(sourceRoot, {
    targetIds: ['vscode'],
    runtime,
  });
  assert.equal(inspection.targets[0]?.status, 'failed');
  assert.match(inspection.targets[0]?.message ?? '', /来源重叠.*来源只读/);
  const report = await executeMarketplaceRegistration(inspection, { runtime });
  assert.equal(report.exitCode, 1);
  assert.equal(report.results[0]?.status, 'failed');
  assert.equal(writes, 0);
  assert.deepEqual(snapshotDirectory(sourceRoot), sourceBefore);

  const equalPathInspection = await inspectMarketplaceRegistration(sourceRoot, {
    targetIds: ['vscode'],
    runtime: {
      ...runtime,
      inspectVscode: () => ({ status: 'ready' as const, settingsPath: sourceRoot }),
    },
  });
  assert.equal(equalPathInspection.targets[0]?.status, 'failed');
  assert.match(equalPathInspection.targets[0]?.message ?? '', /来源重叠/);
  assert.equal(writes, 0);
  assert.deepEqual(snapshotDirectory(sourceRoot), sourceBefore);

  if (process.platform !== 'win32') {
    const sourceOwnedDirectory = join(sourceRoot, 'source-owned-user');
    mkdirSync(sourceOwnedDirectory);
    writeFileSync(join(sourceOwnedDirectory, 'marker'), 'unchanged\n');
    const aliasRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-vscode-source-alias-'));
    const aliasPath = join(aliasRoot, 'user-alias');
    symlinkSync(sourceOwnedDirectory, aliasPath, 'dir');
    const aliasSettingsPath = join(aliasPath, 'settings.json');
    const symlinkSourceBefore = snapshotDirectory(sourceRoot);
    const symlinkRuntime = {
      ...runtime,
      inspectVscode: () => ({
        status: 'ready' as const,
        settingsPath: aliasSettingsPath,
      }),
    };
    const symlinkInspection = await inspectMarketplaceRegistration(sourceRoot, {
      targetIds: ['vscode'],
      runtime: symlinkRuntime,
    });
    assert.equal(symlinkInspection.targets[0]?.status, 'failed');
    assert.match(symlinkInspection.targets[0]?.message ?? '', /来源重叠/);
    const symlinkReport = await executeMarketplaceRegistration(symlinkInspection, {
      runtime: symlinkRuntime,
    });
    assert.equal(symlinkReport.exitCode, 1);
    assert.equal(writes, 0);
    assert.deepEqual(snapshotDirectory(sourceRoot), symlinkSourceBefore);
  }
}

async function testRegistrationInterruption(): Promise<void> {
  const runner = new FakeProcessRunner((request) => {
    if (request.executable === 'codex' && request.args.includes('--help')) {
      return { status: 'missing', stdout: '', stderr: '', message: 'ENOENT' };
    }
    if (!request.args.includes('--help') && request.executable === 'claude') {
      return { status: 'interrupted', signal: 'SIGINT', stdout: '', stderr: '' };
    }
    return completedProcess();
  });
  const inspection = await inspectMarketplaceRegistration('owner/repo', {
    targetIds: ['claude', 'codex', 'cursor'],
    runtime: { processRunner: runner },
  });
  const report = await executeMarketplaceRegistration(inspection, {
    runtime: { processRunner: runner },
  });
  assert.equal(report.exitCode, 130);
  assert.deepEqual(report.results.map((result) => result.id), ['claude', 'codex', 'cursor']);
  assert.equal(report.results[0]?.status, 'interrupted');
  assert.deepEqual(
    report.results.slice(1).map((result) => result.status),
    ['missing-cli', 'manual-required'],
  );
  assert.match(report.results[1]?.recovery ?? '', /安装或升级 Codex CLI/);
  assert.match(report.results[2]?.recovery ?? '', /Dashboard.*Plugins.*Add Marketplace/);
  assert.equal(
    runner.requests.filter((request) => !request.args.includes('--help')).length,
    1,
  );
}

async function testInspectionInterruption(): Promise<void> {
  let addCalls = 0;
  const runner = new FakeProcessRunner((request) => {
    if (!request.args.includes('--help')) {
      addCalls += 1;
      return completedProcess();
    }
    if (request.executable === 'codex') {
      return { status: 'interrupted', signal: 'SIGINT', stdout: '', stderr: '' };
    }
    return completedProcess();
  });
  const inspection = await inspectMarketplaceRegistration('owner/repo', {
    targetIds: ['claude', 'codex', 'copilot'],
    runtime: { processRunner: runner },
  });
  assert.deepEqual(
    inspection.targets.map((target) => target.id),
    ['claude', 'codex', 'copilot'],
  );
  const report = await executeMarketplaceRegistration(inspection, {
    runtime: { processRunner: runner },
  });
  assert.equal(report.exitCode, 130);
  assert.deepEqual(report.results.map((result) => result.id), ['claude', 'codex', 'copilot']);
  assert.deepEqual(
    report.results.map((result) => result.status),
    ['interrupted', 'interrupted', 'interrupted'],
  );
  assert.match(report.results[0]?.message ?? '', /能力探测阶段中断未执行注册/);
  assert.match(report.results[2]?.message ?? '', /因前序目标中断未执行/);
  assert.equal(addCalls, 0);
}

async function testCommandSelectionAndPresentation(): Promise<void> {
  assert.deepEqual(
    parseTargetSelection('3, 1, 1', ['claude', 'codex', 'copilot', 'vscode', 'cursor'], [
      'claude',
    ]),
    ['claude', 'copilot'],
  );
  assert.deepEqual(
    parseTargetSelection('', ['claude', 'codex', 'copilot', 'vscode', 'cursor'], [
      'claude',
      'vscode',
    ]),
    ['claude', 'vscode'],
  );
  assert.deepEqual(
    parseTargetSelection('all', ['claude', 'codex', 'copilot', 'vscode', 'cursor'], []),
    ['claude', 'codex', 'copilot', 'vscode', 'cursor'],
  );
  expectThrows(
    () => parseTargetSelection('1-3', ['claude', 'codex'], ['claude']),
    /编号/,
  );

  const runner = new FakeProcessRunner(() => completedProcess());
  const output: string[] = [];
  const result = await runInstallRepo(
    'owner/repo',
    { agent: ['cursor', 'claude', 'claude'], all: false },
    {
      runtime: { processRunner: runner },
      write: (text) => output.push(text),
      interactive: false,
    },
  );
  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.report?.results.map((item) => item.id), ['claude', 'cursor']);
  const rendered = output.join('');
  assert.match(rendered, /\[完成\] Claude Code/);
  assert.match(rendered, /\[需手动\] Cursor/);
  assert.match(rendered, /已完成/);
  assert.match(rendered, /未完成/);

  const streamingOutput: string[] = [];
  const streamingRunner = new FakeProcessRunner((request) => {
    if (request.executable === 'codex' && !request.args.includes('--help')) {
      assert.match(streamingOutput.join(''), /\[完成\] Claude Code/);
    }
    return completedProcess();
  });
  const streamed = await runInstallRepo(
    'owner/repo',
    { agent: ['claude', 'codex'], all: false },
    {
      runtime: { processRunner: streamingRunner },
      write: (text) => streamingOutput.push(text),
      interactive: false,
    },
  );
  assert.equal(streamed.exitCode, 0);
  const streamingText = streamingOutput.join('');
  assert.ok(
    streamingText.indexOf('[完成] Claude Code') < streamingText.indexOf('→ Codex:'),
    'Claude 的即时结果应在 Codex 开始前输出',
  );
  assert.equal(streamingText.match(/\[完成\] Claude Code/gu)?.length, 2);

  const preflightOutput: string[] = [];
  const preflightRunner = new FakeProcessRunner((request) => {
    if (request.executable === 'codex' && request.args.includes('--help')) {
      return { status: 'interrupted', signal: 'SIGINT', stdout: '', stderr: '' };
    }
    return completedProcess();
  });
  const preflightInterrupted = await runInstallRepo(
    'owner/repo',
    { agent: ['claude', 'codex', 'cursor'], all: false },
    {
      runtime: { processRunner: preflightRunner },
      write: (text) => preflightOutput.push(text),
      interactive: false,
    },
  );
  assert.equal(preflightInterrupted.exitCode, 130);
  assert.deepEqual(
    preflightInterrupted.report?.results.map((item) => item.id),
    ['claude', 'codex', 'cursor'],
  );
  assert.match(preflightOutput.join(''), /\[中断\] Claude Code/);
  assert.match(preflightOutput.join(''), /\[中断\] Codex/);
  assert.match(preflightOutput.join(''), /\[中断\] Cursor/);
  assert.match(preflightOutput.join(''), /因前序目标中断未执行/);

  await assert.rejects(
    runInstallRepo(
      'owner/repo',
      { agent: [], all: false },
      { runtime: { processRunner: runner }, interactive: false, write: () => undefined },
    ),
    /非交互终端必须显式传入/,
  );
  await assert.rejects(
    runInstallRepo(
      'owner/repo',
      { agent: ['claude'], all: true },
      { runtime: { processRunner: runner }, interactive: false, write: () => undefined },
    ),
    /不能同时使用/,
  );

  const promptOutput: string[] = [];
  const promptSettingsPath = join(
    mkdtempSync(join(tmpdir(), 'agent-plugkit-prompt-settings-')),
    'settings.json',
  );
  const prompted = await runInstallRepo(
    'owner/repo',
    { agent: [], all: false },
    {
      runtime: {
        processRunner: new FakeProcessRunner(() => completedProcess()),
        inspectVscode: () => ({ status: 'ready', settingsPath: promptSettingsPath }),
        updateVscode: () => ({
          status: 'completed',
          changed: true,
          settingsPath: promptSettingsPath,
        }),
      },
      interactive: true,
      readSelection: async () => '',
      write: (text) => promptOutput.push(text),
    },
  );
  assert.equal(prompted.exitCode, 0);
  assert.deepEqual(prompted.report?.results.map((item) => item.id), [
    'claude',
    'codex',
    'copilot',
    'vscode',
  ]);
  assert.doesNotMatch(promptOutput.join(''), /\[完成\] Cursor/);

  const allTargets = await runInstallRepo(
    'owner/repo',
    { agent: [], all: true },
    {
      runtime: {
        processRunner: new FakeProcessRunner(() => completedProcess()),
        inspectVscode: () => ({ status: 'ready', settingsPath: promptSettingsPath }),
        updateVscode: () => ({
          status: 'completed',
          changed: false,
          settingsPath: promptSettingsPath,
        }),
      },
      interactive: false,
      write: () => undefined,
    },
  );
  assert.equal(allTargets.exitCode, 2);
  assert.deepEqual(allTargets.report?.results.map((item) => item.id), [
    'claude',
    'codex',
    'copilot',
    'vscode',
    'cursor',
  ]);

  let interruptedAdds = 0;
  const promptInterrupted = await runInstallRepo(
    'owner/repo',
    { agent: [], all: false },
    {
      runtime: {
        processRunner: new FakeProcessRunner((request) => {
          if (!request.args.includes('--help')) interruptedAdds += 1;
          return completedProcess();
        }),
        inspectVscode: () => ({ status: 'unavailable', message: 'not installed' }),
      },
      interactive: true,
      readSelection: async () => undefined,
      write: () => undefined,
    },
  );
  assert.equal(promptInterrupted.exitCode, 130);
  assert.equal(interruptedAdds, 0);

  let promptRaceRead = false;
  let promptRaceInterrupted = false;
  const promptRaceOutput: string[] = [];
  const promptRace = await runInstallRepo(
    'owner/repo',
    { agent: [], all: false },
    {
      runtime: {
        processRunner: new FakeProcessRunner(() => completedProcess()),
        inspectVscode: () => ({ status: 'unavailable', message: 'not installed' }),
      },
      interactive: true,
      readSelection: async () => {
        promptRaceRead = true;
        return '';
      },
      write: (text) => {
        promptRaceOutput.push(text);
        if (!promptRaceInterrupted && text.includes('输入编号')) {
          promptRaceInterrupted = true;
          process.emit('SIGINT');
        }
      },
    },
  );
  assert.equal(promptRace.exitCode, 130);
  assert.equal(promptRaceRead, false);
  assert.match(promptRaceOutput.join(''), /\[中断\]/);

  let readingAdds = 0;
  const readingOutput: string[] = [];
  const readingInterrupted = await runInstallRepo(
    'owner/repo',
    { agent: [], all: false },
    {
      runtime: {
        processRunner: new FakeProcessRunner((request) => {
          if (!request.args.includes('--help')) readingAdds += 1;
          return completedProcess();
        }),
        inspectVscode: () => ({ status: 'unavailable', message: 'not installed' }),
      },
      interactive: true,
      readSelection: async (signal) =>
        await new Promise<string | undefined>((resolveSelection) => {
          signal.addEventListener('abort', () => resolveSelection(undefined), { once: true });
          setImmediate(() => process.emit('SIGINT'));
        }),
      write: (text) => readingOutput.push(text),
    },
  );
  assert.equal(readingInterrupted.exitCode, 130);
  assert.equal(readingAdds, 0);
  assert.match(readingOutput.join(''), /\[中断\]/);
}

async function testPreAbortedProcessRunner(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'agent-plugkit-pre-aborted-runner-'));
  const executablePath = join(root, 'must-not-run');
  const markerPath = join(root, 'spawned');
  writeFileSync(
    executablePath,
    `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned');\n`,
  );
  chmodSync(executablePath, 0o755);
  const controller = new AbortController();
  controller.abort('SIGINT');
  const result = await systemProcessRunner.run({
    executable: executablePath,
    args: [],
    captureOutput: true,
    signal: controller.signal,
  });
  assert.equal(result.status, 'interrupted');
  assert.equal(existsSync(markerPath), false);
}

interface CliResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly output: string;
}

function writeFakeClient(binDir: string, name: string): void {
  const executablePath = join(binDir, name);
  writeFileSync(
    executablePath,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const name = path.basename(process.argv[1]);
const mode = process.env['AGENT_PLUGKIT_FAKE_' + name.toUpperCase()] || 'ok';
if (mode === 'ignore-interrupt' || mode === 'probe-ignore-interrupt') {
  process.on('SIGINT', () => undefined);
}
fs.appendFileSync(process.env.AGENT_PLUGKIT_FAKE_LOG, JSON.stringify({ name, args }) + '\\n');
if (args.includes('--help')) {
  if (mode === 'probe-wait' || mode === 'probe-ignore-interrupt') {
    process.stdout.write('probe waiting\\n');
    setInterval(() => undefined, 1000);
  } else {
    if (mode === 'old') {
      process.stderr.write('unknown command marketplace\\n');
      process.exit(7);
    }
    process.stdout.write(name === 'code' ? 'Visual Studio Code 1.100.0\\n' : name + ' marketplace help\\n');
    process.exit(0);
  }
}
if (mode === 'fail') {
  process.stderr.write('registration rejected\\n');
  process.exit(9);
}
if (mode === 'interrupt') {
  process.kill(process.pid, 'SIGINT');
}
if (mode === 'wait') {
  process.stdout.write('registration waiting\\n');
  setInterval(() => undefined, 1000);
}
if (mode === 'ignore-interrupt') {
  process.stdout.write('registration ignoring interrupt\\n');
  setInterval(() => undefined, 1000);
}
process.stdout.write('registered\\n');
`,
  );
  chmodSync(executablePath, 0o755);
}

async function runCliWithInterrupt(
  args: string[],
  env: NodeJS.ProcessEnv,
  readyToInterrupt: () => boolean,
): Promise<CliResult> {
  return await new Promise<CliResult>((resolveResult, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(process.execPath, ['--import', 'tsx', cliPath, ...args], {
      cwd: cliRoot,
      detached,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let interrupted = false;
    const interrupt = (): void => {
      if (interrupted || !readyToInterrupt() || child.pid === undefined) {
        return;
      }
      interrupted = true;
      try {
        if (detached) {
          process.kill(-child.pid, 'SIGINT');
        } else {
          child.kill('SIGINT');
        }
      } catch (error) {
        reject(error);
      }
    };
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      interrupt();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
      interrupt();
    });
    child.once('error', reject);
    const readinessPoll = setInterval(interrupt, 10);
    const timeout = setTimeout(() => {
      clearInterval(readinessPoll);
      if (child.pid !== undefined) {
        try {
          if (detached) {
            process.kill(-child.pid, 'SIGKILL');
          } else {
            child.kill('SIGKILL');
          }
        } catch {
          // The process may have exited between the timeout and cleanup.
        }
      }
      reject(new Error(`CLI did not finish after interrupt. Output:\n${output}`));
    }, 10_000);
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      clearInterval(readinessPoll);
      resolveResult({ status, signal, output });
    });
  });
}

function runCli(args: string[], env: NodeJS.ProcessEnv, cwd = cliRoot): CliResult {
  const result = spawnSync(process.execPath, [tsxBin, cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env,
  });
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function fakeCliEnvironment(names: string[]): {
  readonly env: NodeJS.ProcessEnv;
  readonly logPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'agent-plugkit-fake-clients-'));
  const binDir = join(root, 'bin');
  mkdirSync(binDir);
  for (const name of names) writeFakeClient(binDir, name);
  const logPath = join(root, 'calls.jsonl');
  return {
    env: {
      ...process.env,
      PATH: binDir,
      AGENT_PLUGKIT_FAKE_LOG: logPath,
    },
    logPath,
  };
}

function readFakeCalls(logPath: string): Array<{ name: string; args: string[] }> {
  try {
    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { name: string; args: string[] });
  } catch {
    return [];
  }
}

function testCliEndToEnd(): void {
  const completeFixture = fakeCliEnvironment(['claude', 'codex']);
  const help = runCli(['--help'], completeFixture.env);
  assert.equal(help.status, 0, help.output);
  assert.match(help.output, /install-repo/);

  const nonTty = runCli(['install-repo', 'owner/repo'], completeFixture.env);
  assert.equal(nonTty.status, 1, nonTty.output);
  assert.match(nonTty.output, /非交互终端必须显式传入/);
  assert.deepEqual(readFakeCalls(completeFixture.logPath), []);

  const completed = runCli(
    [
      'install-repo',
      'owner/repo',
      '--agent',
      'codex',
      '--agent',
      'claude',
      '--agent',
      'claude',
    ],
    completeFixture.env,
  );
  assert.equal(completed.status, 0, completed.output);
  assert.match(completed.output, /\[完成\] Claude Code/);
  assert.match(completed.output, /\[完成\] Codex/);
  assert.deepEqual(readFakeCalls(completeFixture.logPath), [
    { name: 'claude', args: ['plugin', 'marketplace', 'add', '--help'] },
    { name: 'codex', args: ['plugin', 'marketplace', 'add', '--help'] },
    { name: 'claude', args: ['plugin', 'marketplace', 'add', 'owner/repo'] },
    { name: 'codex', args: ['plugin', 'marketplace', 'add', 'owner/repo'] },
  ]);

  const partialFixture = fakeCliEnvironment(['claude']);
  const partial = runCli(
    ['install-repo', 'owner/repo', '--agent', 'claude', '--agent', 'codex'],
    partialFixture.env,
  );
  assert.equal(partial.status, 2, partial.output);
  assert.match(partial.output, /\[完成\] Claude Code/);
  assert.match(partial.output, /\[缺少 CLI\] Codex/);

  const manual = runCli(
    ['install-repo', 'owner/repo', '--agent', 'cursor'],
    partialFixture.env,
  );
  assert.equal(manual.status, 1, manual.output);
  assert.match(manual.output, /\[需手动\] Cursor/);

  const oldFixture = fakeCliEnvironment(['claude']);
  oldFixture.env.AGENT_PLUGKIT_FAKE_CLAUDE = 'old';
  const old = runCli(
    ['install-repo', 'owner/repo', '--agent', 'claude'],
    oldFixture.env,
  );
  assert.equal(old.status, 1, old.output);
  assert.match(old.output, /\[失败\] Claude Code/);
  assert.equal(readFakeCalls(oldFixture.logPath).length, 1);

  const failedFixture = fakeCliEnvironment(['claude', 'codex']);
  failedFixture.env.AGENT_PLUGKIT_FAKE_CLAUDE = 'fail';
  const failed = runCli(
    ['install-repo', 'owner/repo', '--agent', 'claude', '--agent', 'codex'],
    failedFixture.env,
  );
  assert.equal(failed.status, 2, failed.output);
  assert.match(failed.output, /\[失败\] Claude Code/);
  assert.match(failed.output, /\[完成\] Codex/);

  const interruptedFixture = fakeCliEnvironment(['claude', 'codex']);
  interruptedFixture.env.AGENT_PLUGKIT_FAKE_CLAUDE = 'interrupt';
  const interrupted = runCli(
    ['install-repo', 'owner/repo', '--agent', 'claude', '--agent', 'codex'],
    interruptedFixture.env,
  );
  assert.equal(interrupted.status, 130, interrupted.output);
  assert.match(interrupted.output, /\[中断\] Claude Code/);
  assert.match(interrupted.output, /\[中断\] Codex/);
  assert.match(interrupted.output, /因前序目标中断未执行/);
  assert.deepEqual(
    readFakeCalls(interruptedFixture.logPath).filter((call) => !call.args.includes('--help')),
    [{ name: 'claude', args: ['plugin', 'marketplace', 'add', 'owner/repo'] }],
  );

  const invalidTarget = runCli(
    ['install-repo', 'owner/repo', '--agent', 'gemini'],
    partialFixture.env,
  );
  assert.equal(invalidTarget.status, 1, invalidTarget.output);
  assert.match(invalidTarget.output, /未知 agent/);

  const mutuallyExclusive = runCli(
    ['install-repo', 'owner/repo', '--agent', 'claude', '--all'],
    partialFixture.env,
  );
  assert.equal(mutuallyExclusive.status, 1, mutuallyExclusive.output);
  assert.match(mutuallyExclusive.output, /不能同时使用/);

  const injectionFixture = fakeCliEnvironment(['claude']);
  const injectionRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-argv-injection-'));
  const unsafeName = 'market;touch SHOULD_NOT_EXIST';
  const unsafeLocalPath = join(injectionRoot, unsafeName);
  mkdirSync(join(unsafeLocalPath, '.claude-plugin'), { recursive: true });
  writeFileSync(join(unsafeLocalPath, '.claude-plugin/marketplace.json'), '{}\n');
  const unsafeBefore = snapshotDirectory(unsafeLocalPath);
  const injection = runCli(
    ['install-repo', unsafeLocalPath, '--agent', 'claude'],
    injectionFixture.env,
    injectionRoot,
  );
  assert.equal(injection.status, 0, injection.output);
  assert.equal(existsSync(join(injectionRoot, 'SHOULD_NOT_EXIST')), false);
  assert.deepEqual(snapshotDirectory(unsafeLocalPath), unsafeBefore);
  const injectionCalls = readFakeCalls(injectionFixture.logPath);
  assert.deepEqual(injectionCalls.at(-1)?.args, [
    'plugin',
    'marketplace',
    'add',
    realpathSync(unsafeLocalPath),
  ]);

  const controlFixture = fakeCliEnvironment(['claude']);
  const controlRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-control-source-'));
  const controlLocalPath = join(controlRoot, 'marketplace\u001b[2J');
  mkdirSync(join(controlLocalPath, '.claude-plugin'), { recursive: true });
  writeFileSync(join(controlLocalPath, '.claude-plugin/marketplace.json'), '{}\n');
  const control = runCli(
    ['install-repo', controlLocalPath, '--agent', 'claude'],
    controlFixture.env,
    controlRoot,
  );
  assert.equal(control.status, 1, control.output);
  assert.match(control.output, /控制字符/);
  assert.doesNotMatch(control.output, /\u001b/u);
  assert.deepEqual(readFakeCalls(controlFixture.logPath), []);

  const relativeHomeFixture = fakeCliEnvironment([]);
  relativeHomeFixture.env.HOME = 'relative-home';
  delete relativeHomeFixture.env.XDG_CONFIG_HOME;
  delete relativeHomeFixture.env.APPDATA;
  const relativeHomeRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-relative-home-e2e-'));
  relativeHomeFixture.env.INIT_CWD = relativeHomeRoot;
  writeFileSync(join(relativeHomeRoot, 'marketplace.json'), '{}\n');
  const relativeHome = runCli(
    ['install-repo', '.', '--agent', 'vscode'],
    relativeHomeFixture.env,
    relativeHomeRoot,
  );
  assert.equal(relativeHome.status, 1, relativeHome.output);
  assert.match(relativeHome.output, /无法定位.*VS Code/);
  assert.equal(existsSync(join(relativeHomeRoot, 'relative-home')), false);

  const overlappingHomeFixture = fakeCliEnvironment(['code']);
  const overlappingHomeRoot = mkdtempSync(join(tmpdir(), 'agent-plugkit-overlapping-home-e2e-'));
  overlappingHomeFixture.env.HOME = overlappingHomeRoot;
  overlappingHomeFixture.env.INIT_CWD = overlappingHomeRoot;
  delete overlappingHomeFixture.env.XDG_CONFIG_HOME;
  delete overlappingHomeFixture.env.APPDATA;
  writeFileSync(join(overlappingHomeRoot, 'marketplace.json'), '{}\n');
  const overlappingHomeBefore = snapshotDirectory(overlappingHomeRoot);
  const overlappingHome = runCli(
    ['install-repo', '.', '--agent', 'vscode'],
    overlappingHomeFixture.env,
    overlappingHomeRoot,
  );
  assert.equal(overlappingHome.status, 1, overlappingHome.output);
  assert.match(overlappingHome.output, /来源重叠.*来源只读/);
  assert.deepEqual(snapshotDirectory(overlappingHomeRoot), overlappingHomeBefore);
  assert.deepEqual(readFakeCalls(overlappingHomeFixture.logPath), [
    { name: 'code', args: ['--help'] },
  ]);
}

async function testRealSignalInterruption(): Promise<void> {
  const registrationFixture = fakeCliEnvironment(['claude', 'codex']);
  registrationFixture.env.AGENT_PLUGKIT_FAKE_CLAUDE = 'wait';
  const registration = await runCliWithInterrupt(
    ['install-repo', 'owner/repo', '--agent', 'claude', '--agent', 'codex'],
    registrationFixture.env,
    () =>
      readFakeCalls(registrationFixture.logPath).some(
        (call) => call.name === 'claude' && !call.args.includes('--help'),
      ),
  );
  assert.equal(registration.signal, null, registration.output);
  assert.equal(registration.status, 130, registration.output);
  assert.match(registration.output, /\[中断\] Claude Code/);
  assert.match(registration.output, /\[中断\] Codex/);
  assert.match(registration.output, /未完成/);
  assert.deepEqual(
    readFakeCalls(registrationFixture.logPath).filter((call) => !call.args.includes('--help')),
    [{ name: 'claude', args: ['plugin', 'marketplace', 'add', 'owner/repo'] }],
  );

  const probeFixture = fakeCliEnvironment(['claude', 'codex']);
  probeFixture.env.AGENT_PLUGKIT_FAKE_CLAUDE = 'probe-wait';
  const probe = await runCliWithInterrupt(
    ['install-repo', 'owner/repo', '--agent', 'claude', '--agent', 'codex'],
    probeFixture.env,
    () =>
      readFakeCalls(probeFixture.logPath).some(
        (call) => call.name === 'claude' && call.args.includes('--help'),
      ),
  );
  assert.equal(probe.signal, null, probe.output);
  assert.equal(probe.status, 130, probe.output);
  assert.match(probe.output, /\[中断\] Claude Code/);
  assert.match(probe.output, /\[中断\] Codex/);
  assert.deepEqual(readFakeCalls(probeFixture.logPath), [
    { name: 'claude', args: ['plugin', 'marketplace', 'add', '--help'] },
  ]);

  const ignoringRegistrationFixture = fakeCliEnvironment(['claude', 'codex']);
  ignoringRegistrationFixture.env.AGENT_PLUGKIT_FAKE_CLAUDE = 'ignore-interrupt';
  const ignoringRegistration = await runCliWithInterrupt(
    ['install-repo', 'owner/repo', '--agent', 'claude', '--agent', 'codex'],
    ignoringRegistrationFixture.env,
    () =>
      readFakeCalls(ignoringRegistrationFixture.logPath).some(
        (call) => call.name === 'claude' && !call.args.includes('--help'),
      ),
  );
  assert.equal(ignoringRegistration.signal, null, ignoringRegistration.output);
  assert.equal(ignoringRegistration.status, 130, ignoringRegistration.output);
  assert.match(ignoringRegistration.output, /\[中断\] Claude Code/);
  assert.match(ignoringRegistration.output, /\[中断\] Codex/);

  const ignoringProbeFixture = fakeCliEnvironment(['claude', 'codex']);
  ignoringProbeFixture.env.AGENT_PLUGKIT_FAKE_CLAUDE = 'probe-ignore-interrupt';
  const ignoringProbe = await runCliWithInterrupt(
    ['install-repo', 'owner/repo', '--agent', 'claude', '--agent', 'codex'],
    ignoringProbeFixture.env,
    () =>
      readFakeCalls(ignoringProbeFixture.logPath).some(
        (call) => call.name === 'claude' && call.args.includes('--help'),
      ),
  );
  assert.equal(ignoringProbe.signal, null, ignoringProbe.output);
  assert.equal(ignoringProbe.status, 130, ignoringProbe.output);
  assert.match(ignoringProbe.output, /\[中断\] Claude Code/);
  assert.match(ignoringProbe.output, /\[中断\] Codex/);
}

await testSourceNormalization();
console.log('✓ install-repo source normalization');
await testVscodeSettingsUpdate();
console.log('✓ install-repo VS Code JSONC update');
await testRegistrationRegistry();
console.log('✓ install-repo registration registry');
await testVscodeSourceReadOnlyBoundary();
console.log('✓ install-repo VS Code source read-only boundary');
await testRegistrationInterruption();
console.log('✓ install-repo interruption');
await testInspectionInterruption();
console.log('✓ install-repo inspection interruption');
await testCommandSelectionAndPresentation();
console.log('✓ install-repo command selection and presentation');
await testPreAbortedProcessRunner();
console.log('✓ install-repo pre-aborted process runner');
testCliEndToEnd();
console.log('✓ install-repo CLI end-to-end');
await testRealSignalInterruption();
console.log('✓ install-repo real SIGINT coordination');
