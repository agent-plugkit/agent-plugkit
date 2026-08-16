#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const self = 'scripts/check-public-tree.mjs';
const paths = execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf-8' },
)
  .split('\0')
  .filter(Boolean);
const findings = [];
const allowedLocalPathFixtures = new Set(['packages/cli/scripts/test-install-repo.ts']);

for (const path of paths) {
  const absolute = join(root, path);
  if (!existsSync(absolute)) continue;
  if (
    path === 'DESIGN.md' ||
    path.startsWith('specs/') ||
    path.startsWith('marketplace/') ||
    path === 'docs/product/market-research.md' ||
    [
      'docs/adr/0002-desktop-workspace-foundation.md',
      'docs/adr/0003-workspace-lifecycle-transactions.md',
      'docs/adr/0004-plugin-lifecycle-transactions.md',
      'docs/adr/0005-component-declaration-and-file-capabilities.md',
      'docs/adr/0006-remove-desktop-implementation.md',
    ].includes(path) ||
    path === '.DS_Store' ||
    path.endsWith('/.DS_Store')
  ) {
    findings.push(`${path}: retired, internal, or machine-local path is not allowed`);
  }
  if (/candidate-manifest\.json$|(?:^|\/)(?:implementation|foundation)-report\.md$/.test(path)) {
    findings.push(`${path}: candidate evidence is not public repository content`);
  }
  if (path === self) continue;
  const bytes = readFileSync(absolute);
  if (bytes.includes(0)) continue;
  const text = bytes.toString('utf-8');
  const retiredMarkers = [
    /apps\/desktop/,
    /@agent-plugkit\/desktop/,
    /\bElectron\b/,
    /Lumen OS/,
    /npm run desktop:/,
    /\bT-0(?:0\d|1[0-5])\b/,
    /marketplace\/plugins\/plugkit/,
    /@agent-plugkit\/marketplace/,
    /npm run mp:check/,
    /(?:^|[(`/"'])specs\//m,
    /DESIGN\.md/,
  ];
  if (retiredMarkers.some((pattern) => pattern.test(text))) {
    findings.push(`${path}: retired repository material or coupling`);
  }
  if (!allowedLocalPathFixtures.has(path) && (/\/Users\//.test(text) || /\/private\/tmp\//.test(text))) {
    findings.push(`${path}: machine-local absolute path`);
  }
  if (/(?:AKIA|ASIA)[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|npm_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) {
    findings.push(`${path}: credential-shaped content`);
  }
}

if (findings.length > 0) {
  console.error(`Public repository check failed:\n${findings.map((item) => `- ${item}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Public repository check passed (${paths.length} files inspected).`);
}
