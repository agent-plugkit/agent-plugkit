#!/usr/bin/env tsx
/// <reference types="node" />

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import yaml from 'js-yaml';

interface CliResult {
  status: number | null;
  output: string;
}

interface CodexManifestFixture extends Record<string, unknown> {
  author: Record<string, string>;
  interface: {
    capabilities: string[];
    defaultPrompt: string[];
  };
}

const cliRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const monorepoRoot = join(cliRoot, '..', '..');
const cliPath = join(cliRoot, 'src/cli.ts');
const generateSkillPath = join(cliRoot, 'scripts/generate-skill.ts');
const tsxBin = join(monorepoRoot, 'node_modules/tsx/dist/cli.mjs');
const cliVersion = (
  JSON.parse(readFileSync(join(cliRoot, 'package.json'), 'utf-8')) as { version: string }
).version;

function runTsx(args: string[]): CliResult {
  const result = spawnSync(process.execPath, [tsxBin, ...args], {
    cwd: cliRoot,
    encoding: 'utf-8',
  });
  return {
    status: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function runCli(root: string, args: string[]): CliResult {
  return runTsx([cliPath, '--root', root, ...args]);
}

function assertOk(result: CliResult, label: string): void {
  assert.equal(result.status, 0, `${label} failed:\n${result.output}`);
}

function assertFails(result: CliResult, label: string): void {
  assert.notEqual(result.status, 0, `${label} unexpectedly passed:\n${result.output}`);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf-8')) as unknown;
}

function assertAgentPluginsSchemaValid(
  schemaName: 'plugin' | 'mcp',
  value: unknown,
): void {
  const schema = readJson(
    join(
      cliRoot,
      'scripts/fixtures/agent-plugins/1.0.0',
      `${schemaName}.schema.json`,
    ),
  );
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
  assert.equal(
    validate(value),
    true,
    `${schemaName}.json does not match Agent Plugins 1.0.0: ${JSON.stringify(validate.errors)}`,
  );
}

function tempRoot(name: string): string {
  return mkdtempSync(join(tmpdir(), `agent-plugkit-${name}-`));
}

function writeMarketplaceRoot(name: string): string {
  const root = tempRoot(name);
  writeFileSync(
    join(root, 'marketplace.yaml'),
    'name: fixture-marketplace\n' +
      'description: Fixture marketplace\n' +
      'organization: Fixture Team\n',
  );
  mkdirSync(join(root, 'plugins'), { recursive: true });
  return root;
}

function writeSkillPlugin(root: string, name = 'demo-skill'): void {
  const pluginDir = join(root, 'plugins', name);
  mkdirSync(join(pluginDir, 'skills', name), { recursive: true });
  writeFileSync(
    join(pluginDir, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "Demo skill."\n---\n\n# ${name}\n`,
  );
  writeFileSync(
    join(pluginDir, 'plugin.yaml'),
    `name: ${name}
version: "0.1.0"
description: "Demo skill plugin"
author:
  name: "Fixture Team"
category: tooling
tags:
  - demo
components:
  skills:
    - name: ${name}
      path: skills/${name}
      description: "Demo skill"
`,
  );
}

function writeFullPlugin(root: string): void {
  const name = 'full-plugin';
  const pluginDir = join(root, 'plugins', name);
  mkdirSync(join(pluginDir, 'skills', name), { recursive: true });
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'skills', name, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "Full plugin."\n---\n\n# ${name}\n`,
  );
  const hookPath = join(pluginDir, 'hooks', 'check.sh');
  writeFileSync(hookPath, '#!/bin/bash\nexit 0\n');
  chmodSync(hookPath, 0o755);
  writeFileSync(
    join(pluginDir, 'plugin.yaml'),
    `name: ${name}
version: "0.1.0"
description: "Full plugin"
author:
  name: "Fixture Team"
  email: "plugins@example.com"
  url: "https://example.com/plugins"
homepage: "https://example.com/full-plugin"
repository: "https://github.com/example/full-plugin"
license: "MIT"
category: tooling
tags:
  - demo
  - portable
components:
  skills:
    - name: ${name}
      path: skills/${name}
      description: "Full skill"
  mcp:
    - name: ${name}-server
      command: npx
      args: ["-y", "full-plugin-server"]
      description: "Demo MCP server"
    - name: explicit-stdio
      type: stdio
      command: node
      args: ["./skills/full-plugin/SKILL.md"]
      env:
        MODE: fixture
      cwd: "./skills/full-plugin"
    - name: remote-http
      type: streamable-http
      url: "https://mcp.example.com/rpc"
      headers:
        X-Client-ID: fixture
    - name: remote-sse
      type: sse
      url: "https://mcp.example.com/events"
  hooks:
    - event: PreToolUse
      pattern: "Write|Edit"
      command: "./hooks/check.sh"
  lsp:
    - name: demo
      command: demo-language-server
      extensionToLanguage:
        ".demo": demo
      startupTimeout: 30000
      maxRestarts: 3
      diagnostics: true
platform:
  codex:
    interface:
      displayName: "Full Plugin"
      shortDescription: "Short"
      longDescription: "Long"
      category: "Tooling"
      developerName: "Fixture Team"
      capabilities:
        - "Interactive"
        - "Write"
      defaultPrompt:
        - "Help me use the full plugin."
`,
  );
}

/** 导入源 fixture：一个含 SKILL.md 的目录（可选带 references/ 子目录），另附一个 .DS_Store 噪声文件。 */
function writeSourceSkillDir(
  parent: string,
  dirName: string,
  skillMdContent: string,
  options: { withReferences?: boolean } = {},
): string {
  const dir = join(parent, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), skillMdContent);
  writeFileSync(join(dir, '.DS_Store'), 'junk');
  if (options.withReferences) {
    mkdirSync(join(dir, 'references'), { recursive: true });
    writeFileSync(join(dir, 'references', 'guide.md'), '# Guide\n\nDetails.\n');
  }
  return dir;
}

/** 导入源 fixture：一个已是插件形态的目录（含 skills/<name>/SKILL.md，可多个）。 */
function writeSourcePluginDir(parent: string, dirName: string, skillNames: string[]): string {
  const dir = join(parent, dirName);
  for (const skillName of skillNames) {
    const skillDirPath = join(dir, 'skills', skillName);
    mkdirSync(skillDirPath, { recursive: true });
    writeFileSync(
      join(skillDirPath, 'SKILL.md'),
      `---\nname: ${skillName}\ndescription: "Source skill ${skillName}."\n---\n\n# ${skillName}\n`,
    );
  }
  return dir;
}

function crlf(text: string): string {
  return text.replace(/\n/g, '\r\n');
}

function listFiles(root: string): string[] {
  const result: string[] = [];
  const stack = [''];

  while (stack.length > 0) {
    const rel = stack.pop()!;
    const abs = join(root, rel);
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childRel = join(rel, entry.name);
      if (entry.isDirectory()) {
        stack.push(childRel);
      } else {
        result.push(childRel);
      }
    }
  }

  return result.sort();
}

function testHelpAndVersion(): void {
  assertOk(runTsx([generateSkillPath]), 'generate skill');
  const help = runTsx([cliPath, '--help']);
  assertOk(help, 'help');
  assert.match(help.output, /agent-plugkit/);
  assert.match(help.output, /add/);
  assert.match(help.output, /import-skill/);
  assert.match(help.output, /install-repo/);
  assert.doesNotMatch(help.output, /plugin-marketplace/);
  assert.doesNotMatch(help.output, /marketplace-maintainer|--no-skill/);

  const version = runTsx([cliPath, '--version']);
  assertOk(version, 'version');
  assert.equal(version.output.trim(), cliVersion);
}

function testInitRepo(): void {
  const root = tempRoot('init-repo');
  const initialized = runCli(root, [
    'init-repo',
    'sample-market',
    '--organization',
    'Sample Org',
  ]);
  assertOk(initialized, 'init-repo');
  assert.equal(
    initialized.output,
    `⟳ 初始化 AI agent plugin marketplace 仓库: sample-market
✓ 已初始化官方 plugkit 插件
  → plugins/plugkit/plugin.yaml
  → plugins/plugkit/skills/setup/SKILL.md
  → plugins/plugkit/skills/maintain/SKILL.md
✓ 仓库初始化完成: ${root}
  → npx agent-plugkit init my-plugin
  → npx agent-plugkit add skill plugkit audit
  → npx agent-plugkit validate --all
`,
  );
  assert.equal(existsSync(join(root, 'marketplace.yaml')), true);
  assert.deepEqual(
    (yaml.load(readFileSync(join(root, 'marketplace.yaml'), 'utf8')) as {
      platforms?: unknown;
    }).platforms,
    [
      { name: 'Agent Plugins', manifest: 'plugin.json' },
      { name: 'Claude Code', manifest: '.claude-plugin/plugin.json' },
      { name: 'Codex', manifest: '.codex-plugin/plugin.json' },
    ],
  );
  assert.equal(existsSync(join(root, 'plugins')), true);
  assert.equal(existsSync(join(root, 'plugins/plugkit/plugin.yaml')), true);
  assert.equal(existsSync(join(root, 'plugins/plugkit/skills/setup/SKILL.md')), true);
  assert.equal(existsSync(join(root, 'plugins/plugkit/skills/maintain/SKILL.md')), true);
  const packageJson = readFileSync(join(root, 'package.json'), 'utf-8');
  assert.match(packageJson, /agent-plugkit/);
  assert.doesNotMatch(packageJson, /plugin-marketplace|@birdie|OpenSpec|openspec/);
  assertOk(runCli(root, ['build', '--all']), 'build init-repo');
  assertOk(runCli(root, ['index']), 'index init-repo');
  assertOk(runCli(root, ['validate', '--all']), 'validate init-repo');

  const noPlugkitRoot = tempRoot('init-repo-no-plugkit');
  assertOk(runCli(noPlugkitRoot, ['init-repo', 'empty-market', '--no-plugkit']), 'init-repo no plugkit');
  assert.equal(existsSync(join(noPlugkitRoot, 'plugins')), true);
  assert.equal(existsSync(join(noPlugkitRoot, 'plugins/plugkit/plugin.yaml')), false);

  const conflict = runCli(root, ['init-repo', 'again']);
  assertFails(conflict, 'init-repo existing marketplace');
  assert.match(conflict.output, /marketplace\.yaml 已存在/);
  assert.doesNotMatch(conflict.output, /⟳ 初始化/);

  const preserveRoot = tempRoot('init-repo-preserve');
  writeFileSync(join(preserveRoot, 'README.md'), 'keep readme\n');
  writeFileSync(
    join(preserveRoot, 'package.json'),
    '{"name":"existing","custom":true,"scripts":{"build:plugins":"mine"}}\n',
  );
  mkdirSync(join(preserveRoot, 'plugins/plugkit'), { recursive: true });
  writeFileSync(
    join(preserveRoot, 'plugins/plugkit/plugin.yaml'),
    'name: keep-me\n',
  );
  assertOk(
    runCli(preserveRoot, [
      'init-repo',
      'preserve-market',
      '--organization',
      'Keep Org',
    ]),
    'init-repo preserve',
  );
  assert.equal(readFileSync(join(preserveRoot, 'README.md'), 'utf8'), 'keep readme\n');
  assert.equal(
    readFileSync(join(preserveRoot, 'plugins/plugkit/plugin.yaml'), 'utf8'),
    'name: keep-me\n',
  );
  const preservedPackage = readJson(join(preserveRoot, 'package.json')) as {
    custom?: boolean;
    scripts?: Record<string, string>;
  };
  assert.equal(preservedPackage.custom, true);
  assert.equal(preservedPackage.scripts?.['build:plugins'], 'mine');
  assert.match(preservedPackage.scripts?.['validate:plugins'] ?? '', /agent-plugkit/);

  const invalidPackageRoot = tempRoot('init-repo-invalid-package');
  writeFileSync(
    join(invalidPackageRoot, 'package.json'),
    '{"scripts":"keep this scalar"}\n',
  );
  const invalidPackage = runCli(invalidPackageRoot, [
    'init-repo',
    'invalid-package',
  ]);
  assertFails(invalidPackage, 'init-repo invalid package scripts');
  assert.match(invalidPackage.output, /scripts 必须是 JSON 对象/);
  assert.equal(existsSync(join(invalidPackageRoot, 'marketplace.yaml')), false);
  assert.equal(
    readFileSync(join(invalidPackageRoot, 'package.json'), 'utf8'),
    '{"scripts":"keep this scalar"}\n',
  );
}

function testInitTypesBuildAndValidate(): void {
  const root = writeMarketplaceRoot('init-types');
  for (const type of ['skill', 'mcp', 'lsp', 'hook']) {
    const initialized = runCli(root, ['init', `${type}-plugin`, '--type', type]);
    assertOk(initialized, `init ${type}`);
    if (type === 'skill') {
      assert.equal(
        initialized.output,
        `⟳ 创建插件: skill-plugin (类型: skill)
✓ 插件创建成功: plugins/skill-plugin/
  → 编辑 plugin.yaml 完善配置
  → 编辑 skills/skill-plugin/SKILL.md 编写指令
`,
      );
    }
    assertOk(runCli(root, ['build', `${type}-plugin`]), `build ${type}`);
    assertOk(runCli(root, ['validate', `${type}-plugin`]), `validate ${type}`);
  }

  const pluginYaml = readFileSync(join(root, 'plugins/skill-plugin/plugin.yaml'), 'utf-8');
  assert.match(pluginYaml, /Agent Plugkit Maintainers/);
  assert.doesNotMatch(pluginYaml, /Mobile Team|OpenSpec|openspec/);
  const guidedSkill = readFileSync(
    join(root, 'plugins/skill-plugin/skills/skill-plugin/SKILL.md'),
    'utf8',
  );
  const guidedHeadings = ['## 何时使用', '## 要完成什么', '## 如何执行', '## 需要什么输入'];
  for (const heading of guidedHeadings) assert.match(guidedSkill, new RegExp(heading));
  assert.deepEqual(
    guidedHeadings.map((heading) => guidedSkill.indexOf(heading)),
    [...guidedHeadings.map((heading) => guidedSkill.indexOf(heading))].sort((left, right) => left - right),
  );

  assertFails(runCli(root, ['init', 'bad-plugin', '--type', 'bad']), 'invalid type');
}

function testAddComponents(): void {
  const root = writeMarketplaceRoot('add-components');
  writeSkillPlugin(root, 'demo-plugin');

  assertOk(runCli(root, ['add', 'skill', 'demo-plugin', 'audit']), 'add skill');
  assertOk(runCli(root, ['add', 'mcp', 'demo-plugin', 'demo-server']), 'add mcp');
  assertOk(runCli(root, ['add', 'hook', 'demo-plugin', 'pre-edit']), 'add hook');
  assertOk(runCli(root, ['add', 'lsp', 'demo-plugin', 'demo-language']), 'add lsp');

  const pluginYaml = readFileSync(join(root, 'plugins/demo-plugin/plugin.yaml'), 'utf-8');
  assert.match(pluginYaml, /name: audit/);
  assert.match(pluginYaml, /name: demo-server/);
  assert.match(pluginYaml, /command: \.\/hooks\/pre-edit\.sh/);
  assert.match(pluginYaml, /name: demo-language/);
  const addedSkillPath = join(root, 'plugins/demo-plugin/skills/audit/SKILL.md');
  assert.equal(existsSync(addedSkillPath), true);
  const addedSkill = readFileSync(addedSkillPath, 'utf8');
  for (const heading of ['## 何时使用', '## 要完成什么', '## 如何执行', '## 需要什么输入']) {
    assert.match(addedSkill, new RegExp(heading));
  }
  assert.equal(existsSync(join(root, 'plugins/demo-plugin/hooks/pre-edit.sh')), true);

  assertOk(runCli(root, ['build', 'demo-plugin']), 'build added components');
  assertOk(runCli(root, ['validate', 'demo-plugin']), 'validate added components');

  assertFails(runCli(root, ['add', 'skill', 'demo-plugin', 'audit']), 'duplicate skill');
}

function testImportSkill(): void {
  const srcParent = tempRoot('import-src');

  // 1-5: 基础流程 — 无 [name]，含 references + argument-hint，SKILL.md 无损，build+validate+index 通过
  const basicSrc = writeSourceSkillDir(
    srcParent,
    'dataviz-source',
    '---\n' +
      'name: dataviz\n' +
      'description: "Render charts and dashboards with consistent color systems."\n' +
      'argument-hint: "<chart-type>"\n' +
      '---\n\n# dataviz\n\nGuidance body.\n',
    { withReferences: true },
  );

  const root1 = writeMarketplaceRoot('import-basic');
  const basicImport = runCli(root1, ['import-skill', basicSrc]);
  assertOk(basicImport, 'import-skill basic');
  assert.equal(
    basicImport.output,
    `⟳ 导入 skill: ${basicSrc} → plugins/dataviz
✓ 插件创建成功: plugins/dataviz/
  → 运行 agent-plugkit build dataviz
  → 运行 agent-plugkit validate dataviz
`,
  );
  assert.equal(existsSync(join(root1, 'plugins/dataviz/plugin.yaml')), true);
  assert.equal(existsSync(join(root1, 'plugins/dataviz/skills/dataviz/SKILL.md')), true);
  assert.equal(existsSync(join(root1, 'plugins/dataviz/skills/dataviz/references/guide.md')), true);
  assert.equal(existsSync(join(root1, 'plugins/dataviz/skills/dataviz/.DS_Store')), false);

  const sourceSkillMd = readFileSync(join(basicSrc, 'SKILL.md'), 'utf-8');
  const importedSkillMd = readFileSync(
    join(root1, 'plugins/dataviz/skills/dataviz/SKILL.md'),
    'utf-8',
  );
  assert.equal(importedSkillMd, sourceSkillMd);

  const pluginYaml1 = readFileSync(join(root1, 'plugins/dataviz/plugin.yaml'), 'utf-8');
  assert.match(pluginYaml1, /description:.*Render charts and dashboards/);
  assert.match(pluginYaml1, /argument-hint:.*chart-type/);

  assertOk(runCli(root1, ['build', 'dataviz']), 'build imported dataviz');
  assertOk(runCli(root1, ['validate', 'dataviz']), 'validate imported dataviz');
  assertOk(runCli(root1, ['index']), 'index after import');

  // 6: 显式 name + --description/--author 覆盖 + frontmatter name 不一致告警
  const mismatchSrc = writeSourceSkillDir(
    srcParent,
    'mismatch-source',
    '---\nname: original-skill-name\ndescription: "Original frontmatter description."\n---\n\n# original-skill-name\n',
  );
  const root2 = writeMarketplaceRoot('import-override');
  const overrideResult = runCli(root2, [
    'import-skill',
    mismatchSrc,
    'custom-name',
    '--description',
    'Custom override description.',
    '--author',
    'Custom Author',
  ]);
  assertOk(overrideResult, 'import-skill with overrides');
  assert.equal(
    overrideResult.output,
    `⟳ 导入 skill: ${mismatchSrc} → plugins/custom-name
  ! SKILL.md frontmatter 中的 name (original-skill-name) 与插件名 (custom-name) 不一致，导入不会改写 SKILL.md
✓ 插件创建成功: plugins/custom-name/
  → 运行 agent-plugkit build custom-name
  → 运行 agent-plugkit validate custom-name
`,
  );
  const pluginYaml2 = readFileSync(join(root2, 'plugins/custom-name/plugin.yaml'), 'utf-8');
  assert.match(pluginYaml2, /Custom Author/);
  assert.match(pluginYaml2, /Custom override description\./);
  assert.doesNotMatch(pluginYaml2, /Original frontmatter description/);
  assert.equal(
    readFileSync(join(root2, 'plugins/custom-name/skills/custom-name/SKILL.md'), 'utf-8'),
    readFileSync(join(mismatchSrc, 'SKILL.md'), 'utf-8'),
  );
  assertOk(runCli(root2, ['build', 'custom-name']), 'build mismatched imported skill');
  const mismatchValidation = runCli(root2, ['validate', 'custom-name']);
  assertFails(mismatchValidation, 'validate imported frontmatter mismatch');
  assert.match(mismatchValidation.output, /SKILL\.md name .*与父目录 .*不一致/);

  // 7: 插件形态源，skills/ 下恰好一个 skill，自动选中
  const singlePluginSrc = writeSourcePluginDir(srcParent, 'single-plugin-source', ['solo-skill']);
  const root3 = writeMarketplaceRoot('import-plugin-shape');
  assertOk(runCli(root3, ['import-skill', singlePluginSrc]), 'import-skill plugin-shape auto select');
  assert.equal(existsSync(join(root3, 'plugins/solo-skill/skills/solo-skill/SKILL.md')), true);
  assertOk(runCli(root3, ['build', 'solo-skill']), 'build solo-skill');
  assertOk(runCli(root3, ['validate', 'solo-skill']), 'validate solo-skill');

  // 8: BOM + CRLF 源仍能正确提取 description
  const bomCrlfContent =
    '\ufeff' +
    crlf(
      '---\nname: windows-skill\ndescription: "Windows style line endings should still parse."\n---\n\n# windows-skill\n',
    );
  const bomCrlfSrc = writeSourceSkillDir(srcParent, 'bom-crlf-source', bomCrlfContent);
  const root4 = writeMarketplaceRoot('import-bom-crlf');
  assertOk(runCli(root4, ['import-skill', bomCrlfSrc]), 'import-skill BOM+CRLF');
  const pluginYaml4 = readFileSync(join(root4, 'plugins/windows-skill/plugin.yaml'), 'utf-8');
  assert.match(pluginYaml4, /Windows style line endings should still parse\./);
  assertOk(runCli(root4, ['build', 'windows-skill']), 'build windows-skill');
  assertOk(runCli(root4, ['validate', 'windows-skill']), 'validate windows-skill');

  // 9: 超长 description 截断（按码点计，不能按 UTF-16 code unit 切）。
  // 用 emoji（代理对字符）而非 CJK 填充：CJK 是单 code unit，naive 的 String.slice
  // 和正确的 Array.from 码点切法在 CJK 下结果相同，测不出"误改回 slice"这类回归。
  const longDescription = '😀'.repeat(800);
  const longSrc = writeSourceSkillDir(
    srcParent,
    'long-description-source',
    `---\nname: long-description\ndescription: "${longDescription}"\n---\n\n# long-description\n`,
  );
  const root5 = writeMarketplaceRoot('import-long-description');
  const longResult = runCli(root5, ['import-skill', longSrc]);
  assertOk(longResult, 'import-skill long description');
  assert.match(longResult.output, /已截断/);
  assertOk(runCli(root5, ['build', 'long-description']), 'build long-description');
  assertOk(runCli(root5, ['validate', 'long-description']), 'validate long-description');
  const longConfig = yaml.load(
    readFileSync(join(root5, 'plugins/long-description/plugin.yaml'), 'utf-8'),
  ) as { description: string };
  assert.ok(
    Array.from(longConfig.description).length <= 500,
    'description truncated to 500 codepoints',
  );
  assert.doesNotMatch(
    longConfig.description,
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/,
    'truncation must not split a surrogate pair, leaving a lone half',
  );

  // 10: 无 frontmatter → 导入逐字节保留且 build 可执行；严格 portable validate 阻止交付
  const noFrontmatterSrc = writeSourceSkillDir(
    srcParent,
    'no-frontmatter-source',
    '# no-frontmatter\n\nJust a plain markdown body with no YAML header.\n',
  );
  const root6 = writeMarketplaceRoot('import-no-frontmatter');
  const noFmResult = runCli(root6, ['import-skill', noFrontmatterSrc]);
  assertOk(noFmResult, 'import-skill no frontmatter');
  assert.match(noFmResult.output, /缺少 frontmatter/);
  assert.match(noFmResult.output, /缺少 description/);
  assertOk(runCli(root6, ['build', 'no-frontmatter-source']), 'build no-frontmatter');
  const noFmValidation = runCli(root6, ['validate', 'no-frontmatter-source']);
  assertFails(noFmValidation, 'validate no-frontmatter');
  assert.match(noFmValidation.output, /frontmatter 缺少 name/);
  assert.match(noFmValidation.output, /frontmatter 缺少 description/);
  const noFmYaml = readFileSync(join(root6, 'plugins/no-frontmatter-source/plugin.yaml'), 'utf-8');
  assert.match(noFmYaml, /TODO: 填写插件描述/);

  // 11: 源目录名非 kebab-case（且无 frontmatter），自动规范化并告警
  const rawNameSrc = writeSourceSkillDir(
    srcParent,
    'My_Skill',
    '# My_Skill\n\nNo frontmatter, directory name needs normalization.\n',
  );
  const root7 = writeMarketplaceRoot('import-normalize-name');
  const normalizeResult = runCli(root7, ['import-skill', rawNameSrc]);
  assertOk(normalizeResult, 'import-skill normalizes name');
  assert.match(normalizeResult.output, /插件名已规范化: My_Skill → my-skill/);
  assert.equal(existsSync(join(root7, 'plugins/my-skill/plugin.yaml')), true);

  // 12: 正文中含独立的 --- 行，frontmatter 仍正确闭合解析
  const bodyHrSrc = writeSourceSkillDir(
    srcParent,
    'body-hr-source',
    '---\nname: body-hr\ndescription: "Frontmatter should close before the body separator."\n---\n\n' +
      '# body-hr\n\nIntro paragraph.\n\n---\n\nSection after a horizontal rule in the body.\n',
  );
  const root8 = writeMarketplaceRoot('import-body-hr');
  assertOk(runCli(root8, ['import-skill', bodyHrSrc]), 'import-skill body horizontal rule');
  const bodyHrYaml = readFileSync(join(root8, 'plugins/body-hr/plugin.yaml'), 'utf-8');
  assert.match(bodyHrYaml, /Frontmatter should close before the body separator\./);

  // 负向断言
  const rootNeg = writeMarketplaceRoot('import-negative');

  // 13: 源不存在
  const missingResult = runCli(rootNeg, ['import-skill', join(srcParent, 'does-not-exist')]);
  assertFails(missingResult, 'source missing');
  assert.match(missingResult.output, /源路径不存在/);

  // 14: 源指向 SKILL.md 文件本身
  const fileSourceResult = runCli(rootNeg, ['import-skill', join(basicSrc, 'SKILL.md')]);
  assertFails(fileSourceResult, 'source is a file');
  assert.match(fileSourceResult.output, /源路径不是目录/);

  // 15: 源既无 SKILL.md 也无 skills/
  const emptyDir = join(srcParent, 'empty-source');
  mkdirSync(emptyDir, { recursive: true });
  const noSkillResult = runCli(rootNeg, ['import-skill', emptyDir]);
  assertFails(noSkillResult, 'no SKILL.md or skills/');
  assert.match(noSkillResult.output, /未找到 SKILL\.md/);

  // 16: 插件形态源含多个 skill
  const multiPluginSrc = writeSourcePluginDir(srcParent, 'multi-plugin-source', [
    'skill-alpha',
    'skill-beta',
  ]);
  const multiResult = runCli(rootNeg, ['import-skill', multiPluginSrc]);
  assertFails(multiResult, 'multiple skills in source');
  assert.match(multiResult.output, /包含多个 skill/);
  assert.match(multiResult.output, /skill-alpha/);
  assert.match(multiResult.output, /skill-beta/);

  // 17: 重复导入同名插件
  const dupResult = runCli(root1, ['import-skill', basicSrc]);
  assertFails(dupResult, 'duplicate plugin dir');
  assert.match(dupResult.output, /插件目录已存在/);

  // 18: 显式 [name] 非 kebab-case
  const badNameResult = runCli(rootNeg, ['import-skill', basicSrc, 'Bad_Name']);
  assertFails(badNameResult, 'explicit bad name');
  assert.match(badNameResult.output, /必须使用 kebab-case/);

  // 19: --description 为空
  const emptyDescResult = runCli(rootNeg, [
    'import-skill',
    basicSrc,
    'whatever-name',
    '--description',
    '   ',
  ]);
  assertFails(emptyDescResult, 'empty description override');
  assert.match(emptyDescResult.output, /--description 不能为空/);

  // 20: frontmatter 顶层不是对象
  const stringFmSrc = writeSourceSkillDir(
    srcParent,
    'string-frontmatter-source',
    '---\njust a plain string\n---\n\n# string-frontmatter\n',
  );
  const stringFmResult = runCli(rootNeg, ['import-skill', stringFmSrc]);
  assertFails(stringFmResult, 'frontmatter not object');
  assert.match(stringFmResult.output, /frontmatter 不是对象/);

  // 21: 源目录含符号链接 → 拒绝，且不留半成品插件目录（plan-before-write 契约）
  const symlinkSrcDir = join(srcParent, 'symlink-source');
  mkdirSync(symlinkSrcDir, { recursive: true });
  writeFileSync(
    join(symlinkSrcDir, 'SKILL.md'),
    '---\nname: symlink-skill\ndescription: "Has a symlink inside."\n---\n\n# symlink-skill\n',
  );
  symlinkSync(join(symlinkSrcDir, 'SKILL.md'), join(symlinkSrcDir, 'SKILL.md.link'));
  const symlinkRoot = writeMarketplaceRoot('import-symlink');
  const symlinkResult = runCli(symlinkRoot, ['import-skill', symlinkSrcDir]);
  assertFails(symlinkResult, 'source contains symlink');
  assert.match(symlinkResult.output, /符号链接/);
  assert.equal(existsSync(join(symlinkRoot, 'plugins/symlink-skill')), false);

  // 22: 纯 CJK 目录名 + 无 frontmatter + 无 [name] → 无法推导插件名
  const cjkSrc = writeSourceSkillDir(srcParent, '渲染图', '# 渲染图\n\n没有 frontmatter。\n');
  const cjkRoot = writeMarketplaceRoot('import-cjk-name');
  const cjkResult = runCli(cjkRoot, ['import-skill', cjkSrc]);
  assertFails(cjkResult, 'cannot derive plugin name from CJK dir');
  assert.match(cjkResult.output, /无法从源推导插件名/);
}

function testBuildIndexValidateAndRelease(): void {
  const root = writeMarketplaceRoot('full-flow');
  writeSkillPlugin(root);
  writeFullPlugin(root);
  writeFileSync(join(root, 'plugins/demo-skill/mcp.json'), '{"stale":true}\n');

  assertOk(runCli(root, ['build', '--all']), 'build all');

  const skillOnlyPortableManifestPath = join(root, 'plugins/demo-skill/plugin.json');
  const skillOnlyPortableManifest = readJson(skillOnlyPortableManifestPath);
  assert.deepEqual(skillOnlyPortableManifest, {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'demo-skill',
    version: '0.1.0',
    description: 'Demo skill plugin',
    author: { name: 'Fixture Team' },
    keywords: ['demo'],
  });
  assertAgentPluginsSchemaValid('plugin', skillOnlyPortableManifest);
  assert.equal(existsSync(join(root, 'plugins/demo-skill/mcp.json')), false);

  const portableManifestPath = join(root, 'plugins/full-plugin/plugin.json');
  const portableManifest = readJson(portableManifestPath);
  assert.deepEqual(portableManifest, {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'full-plugin',
    version: '0.1.0',
    description: 'Full plugin',
    author: {
      name: 'Fixture Team',
      email: 'plugins@example.com',
      url: 'https://example.com/plugins',
    },
    homepage: 'https://example.com/full-plugin',
    repository: 'https://github.com/example/full-plugin',
    license: 'MIT',
    keywords: ['demo', 'portable'],
  });
  assertAgentPluginsSchemaValid('plugin', portableManifest);

  const portableMcpPath = join(root, 'plugins/full-plugin/mcp.json');
  const portableMcp = readJson(portableMcpPath);
  assert.deepEqual(portableMcp, {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: {
      'full-plugin-server': {
        type: 'stdio',
        command: 'npx',
        args: ['-y', 'full-plugin-server'],
      },
      'explicit-stdio': {
        type: 'stdio',
        command: 'node',
        args: ['./skills/full-plugin/SKILL.md'],
        env: { MODE: 'fixture' },
        cwd: './skills/full-plugin',
      },
      'remote-http': {
        type: 'streamable-http',
        url: 'https://mcp.example.com/rpc',
        headers: { 'X-Client-ID': 'fixture' },
      },
      'remote-sse': {
        type: 'sse',
        url: 'https://mcp.example.com/events',
      },
    },
  });
  assertAgentPluginsSchemaValid('mcp', portableMcp);

  assert.deepEqual(readJson(join(root, 'plugins/full-plugin/.mcp.json')), {
    mcpServers: {
      'full-plugin-server': {
        command: 'npx',
        args: ['-y', 'full-plugin-server'],
      },
      'explicit-stdio': {
        type: 'stdio',
        command: 'node',
        args: ['./skills/full-plugin/SKILL.md'],
        env: { MODE: 'fixture' },
        cwd: './skills/full-plugin',
      },
      'remote-http': {
        type: 'streamable-http',
        url: 'https://mcp.example.com/rpc',
        headers: { 'X-Client-ID': 'fixture' },
      },
      'remote-sse': {
        type: 'sse',
        url: 'https://mcp.example.com/events',
      },
    },
  });
  assert.deepEqual(readJson(join(root, 'plugins/full-plugin/hooks/hooks.json')), {
    hooks: {
      PreToolUse: [
        {
          matcher: 'Write|Edit',
          hooks: [{ type: 'command', command: './hooks/check.sh' }],
        },
      ],
    },
  });
  assert.deepEqual(readJson(join(root, 'plugins/full-plugin/.lsp.json')), {
    demo: {
      command: 'demo-language-server',
      extensionToLanguage: { '.demo': 'demo' },
      startupTimeout: 30000,
      maxRestarts: 3,
      diagnostics: true,
    },
  });

  const portableBytes = readFileSync(portableManifestPath, 'utf-8');
  const portableMcpBytes = readFileSync(portableMcpPath, 'utf-8');
  assertOk(runCli(root, ['build', '--all']), 'repeat portable build');
  assert.equal(readFileSync(portableManifestPath, 'utf-8'), portableBytes);
  assert.equal(readFileSync(portableMcpPath, 'utf-8'), portableMcpBytes);

  assertOk(runCli(root, ['index']), 'index');
  const portableMarketplace = {
    name: 'fixture-marketplace',
    owner: { name: 'Fixture Team' },
    metadata: { description: 'Fixture marketplace' },
    plugins: [
      {
        name: 'demo-skill',
        source: './plugins/demo-skill',
        description: 'Demo skill plugin',
        version: '0.1.0',
        author: { name: 'Fixture Team' },
      },
      {
        name: 'full-plugin',
        source: './plugins/full-plugin',
        description: 'Full plugin',
        version: '0.1.0',
        author: {
          name: 'Fixture Team',
          email: 'plugins@example.com',
          url: 'https://example.com/plugins',
        },
      },
    ],
  };
  const copilotMarketplacePath = join(
    root,
    '.github/plugin/marketplace.json',
  );
  const cursorMarketplacePath = join(
    root,
    '.cursor-plugin/marketplace.json',
  );
  assert.deepEqual(readJson(copilotMarketplacePath), portableMarketplace);
  assert.deepEqual(readJson(cursorMarketplacePath), portableMarketplace);
  assert.deepEqual(readJson(join(root, 'marketplace.json')), portableMarketplace);
  assert.equal(
    readFileSync(join(root, 'marketplace.json'), 'utf8'),
    readFileSync(copilotMarketplacePath, 'utf8'),
  );
  const copilotMarketplaceBytes = readFileSync(copilotMarketplacePath, 'utf8');
  const cursorMarketplaceBytes = readFileSync(cursorMarketplacePath, 'utf8');
  assertOk(runCli(root, ['index']), 'repeat index');
  assert.equal(readFileSync(copilotMarketplacePath, 'utf8'), copilotMarketplaceBytes);
  assert.equal(readFileSync(cursorMarketplacePath, 'utf8'), cursorMarketplaceBytes);
  assertOk(runCli(root, ['validate', '--all']), 'validate all');

  const codexManifest = readJson(
    join(root, 'plugins/full-plugin/.codex-plugin/plugin.json'),
  ) as CodexManifestFixture;
  assert.equal(Object.prototype.hasOwnProperty.call(codexManifest, 'lspServers'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(codexManifest, 'hooks'), false);
  assert.deepEqual(codexManifest.author, {
    name: 'Fixture Team',
    email: 'plugins@example.com',
    url: 'https://example.com/plugins',
  });
  assert.deepEqual(codexManifest.interface.capabilities, ['Interactive', 'Write']);
  assert.deepEqual(codexManifest.interface.defaultPrompt, ['Help me use the full plugin.']);

  const legacyCodexManifest = readJson(
    join(root, 'plugins/demo-skill/.codex-plugin/plugin.json'),
  ) as CodexManifestFixture;
  assert.deepEqual(legacyCodexManifest.author, { name: 'Fixture Team' });
  assert.deepEqual(legacyCodexManifest.interface.capabilities, []);
  assert.deepEqual(legacyCodexManifest.interface.defaultPrompt, ['Help me use Demo Skill.']);
  assert.equal(existsSync(join(root, '.claude-plugin/marketplace.json')), true);
  assert.equal(existsSync(join(root, '.agents/plugins/marketplace.json')), true);
  assert.equal(existsSync(copilotMarketplacePath), true);
  assert.equal(existsSync(cursorMarketplacePath), true);
  assert.equal(existsSync(join(root, 'marketplace.json')), true);
  assert.equal(existsSync(join(root, 'plugins/CATALOG.md')), true);
  assert.equal(existsSync(join(root, '.openspec-plugin')), false);

  rmSync(join(root, 'plugins/CATALOG.md'));
  const missingCatalogRelease = runCli(root, ['release-local']);
  assertFails(missingCatalogRelease, 'release-local requires CATALOG');
  assert.match(
    missingCatalogRelease.output,
    /plugins\/CATALOG\.md 不存在，请先运行 npm run ci:local/,
  );
  assert.equal(existsSync(join(root, 'dist')), false);
  assertOk(runCli(root, ['index']), 'restore index after release preflight');

  rmSync(copilotMarketplacePath);
  const missingCopilotRelease = runCli(root, ['release-local']);
  assertFails(missingCopilotRelease, 'release-local requires Copilot marketplace');
  assert.match(
    missingCopilotRelease.output,
    /GitHub Copilot marketplace manifest 不存在，请先运行 npm run ci:local/,
  );
  assert.equal(existsSync(join(root, 'dist')), false);
  assertOk(runCli(root, ['index']), 'restore Copilot marketplace after release preflight');

  rmSync(join(root, 'plugins/full-plugin/.mcp.json'));
  const missingMcpRelease = runCli(root, ['release-local']);
  assertFails(missingMcpRelease, 'release-local requires component output');
  assert.match(
    missingMcpRelease.output,
    /full-plugin MCP 配置 不存在，请先运行 npm run ci:local/,
  );
  assert.equal(existsSync(join(root, 'dist')), false);
  assertOk(runCli(root, ['build', 'full-plugin']), 'restore full plugin after release preflight');

  mkdirSync(join(root, '.claude-plugin/metadata'), { recursive: true });
  writeFileSync(
    join(root, '.claude-plugin/metadata/channel.json'),
    '{"channel":"local"}\n',
  );
  mkdirSync(join(root, '.agents/skills/helper'), { recursive: true });
  writeFileSync(join(root, '.agents/skills/helper/SKILL.md'), '# Helper\n');

  assertOk(runCli(root, ['release-local']), 'release-local');
  const releaseFiles = listFiles(join(root, 'dist/release'));
  assert.ok(releaseFiles.includes('release-manifest.json'));
  assert.ok(releaseFiles.includes('README.md'));
  assert.ok(releaseFiles.includes('.github/plugin/marketplace.json'));
  assert.ok(releaseFiles.includes('.cursor-plugin/marketplace.json'));
  assert.ok(releaseFiles.includes('plugins/demo-skill/plugin.json'));
  assert.ok(releaseFiles.includes('plugins/full-plugin/mcp.json'));
  assert.equal(releaseFiles.some((file) => file.includes('.openspec-plugin')), false);
  const releaseReadme = readFileSync(join(root, 'dist/release/README.md'), 'utf-8');
  assert.match(releaseReadme, /agent-plugkit release-local/);
  assert.doesNotMatch(releaseReadme, /plugin-marketplace|OpenSpec|openspec/);
  assert.equal(
    readFileSync(
      join(root, 'dist/release/.claude-plugin/metadata/channel.json'),
      'utf-8',
    ),
    '{"channel":"local"}\n',
  );
  assert.equal(
    readFileSync(join(root, 'dist/release/.agents/skills/helper/SKILL.md'), 'utf-8'),
    '# Helper\n',
  );
}

function testAgentPluginsSourceSchemaValidation(): void {
  const metadataRoot = writeMarketplaceRoot('agent-plugins-metadata-presence');
  writeSkillPlugin(metadataRoot, 'metadata-presence');
  const metadataYamlPath = join(
    metadataRoot,
    'plugins/metadata-presence/plugin.yaml',
  );
  writeFileSync(
    metadataYamlPath,
    readFileSync(metadataYamlPath, 'utf-8').replace(
      'author:\n  name: "Fixture Team"\ncategory:',
      'author:\n  name: "Fixture Team"\n  email: ""\n  url: ""\nhomepage: ""\nrepository: ""\nlicense: ""\ncategory:',
    ),
  );
  assertOk(
    runCli(metadataRoot, ['build', 'metadata-presence']),
    'portable metadata maps by field presence',
  );
  const metadataManifest = readJson(
    join(metadataRoot, 'plugins/metadata-presence/plugin.json'),
  );
  assert.deepEqual(metadataManifest, {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'metadata-presence',
    version: '0.1.0',
    description: 'Demo skill plugin',
    author: { name: 'Fixture Team', email: '', url: '' },
    homepage: '',
    repository: '',
    license: '',
    keywords: ['demo'],
  });
  assertAgentPluginsSchemaValid('plugin', metadataManifest);
  assertOk(runCli(metadataRoot, ['index']), 'portable empty metadata index');
  const emptyAuthor = (
    readJson(join(metadataRoot, '.github/plugin/marketplace.json')) as {
      plugins: Array<{ author: unknown }>;
    }
  ).plugins[0]!.author;
  assert.deepEqual(emptyAuthor, { name: 'Fixture Team', email: '', url: '' });

  writeFileSync(
    metadataYamlPath,
    readFileSync(metadataYamlPath, 'utf-8').replace(
      '  email: ""\n  url: ""\nhomepage: ""\nrepository: ""\nlicense: ""',
      '  email: null\n  url: null\nhomepage: null\nrepository: null\nlicense: null',
    ),
  );
  assertOk(
    runCli(metadataRoot, ['build', 'metadata-presence']),
    'portable null metadata build',
  );
  assertOk(runCli(metadataRoot, ['index']), 'portable null metadata index');
  const nullManifest = readJson(
    join(metadataRoot, 'plugins/metadata-presence/plugin.json'),
  ) as Record<string, unknown>;
  assert.deepEqual(nullManifest.author, { name: 'Fixture Team' });
  assert.equal(Object.prototype.hasOwnProperty.call(nullManifest, 'homepage'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(nullManifest, 'repository'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(nullManifest, 'license'), false);
  assertAgentPluginsSchemaValid('plugin', nullManifest);
  const nullAuthor = (
    readJson(join(metadataRoot, '.github/plugin/marketplace.json')) as {
      plugins: Array<{ author: unknown }>;
    }
  ).plugins[0]!.author;
  assert.deepEqual(nullAuthor, { name: 'Fixture Team' });

  const stdioRoot = writeMarketplaceRoot('agent-plugins-invalid-stdio');
  writeFullPlugin(stdioRoot);
  const stdioYamlPath = join(stdioRoot, 'plugins/full-plugin/plugin.yaml');
  writeFileSync(
    stdioYamlPath,
    readFileSync(stdioYamlPath, 'utf-8').replace(
      '      command: node\n',
      '      command: node\n      url: "https://mcp.example.com/invalid"\n',
    ),
  );
  const invalidStdio = runCli(stdioRoot, ['build', 'full-plugin']);
  assertFails(invalidStdio, 'stdio MCP rejects remote fields');
  assert.match(invalidStdio.output, /must NOT have additional properties/);
  assert.equal(existsSync(join(stdioRoot, 'plugins/full-plugin/plugin.json')), false);

  const remoteRoot = writeMarketplaceRoot('agent-plugins-invalid-remote');
  writeFullPlugin(remoteRoot);
  const remoteYamlPath = join(remoteRoot, 'plugins/full-plugin/plugin.yaml');
  writeFileSync(
    remoteYamlPath,
    readFileSync(remoteYamlPath, 'utf-8').replace(
      '      url: "https://mcp.example.com/rpc"\n',
      '      url: "https://mcp.example.com/rpc"\n      command: npx\n',
    ),
  );
  const invalidRemote = runCli(remoteRoot, ['build', 'full-plugin']);
  assertFails(invalidRemote, 'remote MCP rejects stdio fields');
  assert.match(invalidRemote.output, /must NOT have additional properties/);
  assert.equal(existsSync(join(remoteRoot, 'plugins/full-plugin/plugin.json')), false);

  const invalidNameRoot = writeMarketplaceRoot('agent-plugins-invalid-name');
  writeSkillPlugin(invalidNameRoot, 'double--hyphen');
  const invalidName = runCli(invalidNameRoot, ['build', 'double--hyphen']);
  assertFails(invalidName, 'plugin name rejects consecutive hyphens');
  assert.match(invalidName.output, /must match pattern/);
  assert.equal(
    existsSync(join(invalidNameRoot, 'plugins/double--hyphen/plugin.json')),
    false,
  );
}

function testCodexInterfaceSchemaValidation(): void {
  const root = writeMarketplaceRoot('bad-codex-interface');
  writeSkillPlugin(root, 'bad-codex-interface');
  const pluginYamlPath = join(root, 'plugins/bad-codex-interface/plugin.yaml');
  const yaml = readFileSync(pluginYamlPath, 'utf-8') + `platform:
  codex:
    interface:
      defaultPrompt:
        - ""
        - 42
        - "${'x'.repeat(129)}"
        - "Fourth prompt"
      capabilities:
        - ""
        - 42
`;
  writeFileSync(pluginYamlPath, yaml);

  const result = runCli(root, ['build', 'bad-codex-interface']);
  assertFails(result, 'invalid Codex interface arrays');
  assert.match(result.output, /defaultPrompt\/0/);
  assert.match(result.output, /defaultPrompt\/1/);
  assert.match(result.output, /capabilities\/0/);
  assert.match(result.output, /capabilities\/1/);
  assert.match(result.output, /must NOT have more than 3 items/);
  assert.match(result.output, /must NOT have more than 128 characters/);

  const emptyPromptRoot = writeMarketplaceRoot('empty-default-prompt');
  writeSkillPlugin(emptyPromptRoot, 'empty-default-prompt');
  const emptyPromptYamlPath = join(
    emptyPromptRoot,
    'plugins/empty-default-prompt/plugin.yaml',
  );
  writeFileSync(
    emptyPromptYamlPath,
    readFileSync(emptyPromptYamlPath, 'utf-8') + `platform:
  codex:
    interface:
      defaultPrompt: []
      capabilities: []
`,
  );

  const emptyPrompt = runCli(emptyPromptRoot, ['build', 'empty-default-prompt']);
  assertFails(emptyPrompt, 'empty defaultPrompt');
  assert.match(emptyPrompt.output, /defaultPrompt: must NOT have fewer than 1 items/);
  assert.doesNotMatch(emptyPrompt.output, /capabilities/);
}

function testValidateRejectsDriftAndBadReferences(): void {
  const root = writeMarketplaceRoot('drift');
  writeFullPlugin(root);
  assertOk(runCli(root, ['build', 'full-plugin']), 'build full-plugin');
  assertOk(runCli(root, ['validate', 'full-plugin']), 'validate before drift');

  writeFileSync(join(root, 'plugins/full-plugin/.codex-plugin/plugin.json'), '{"name":"wrong"}\n');
  const drift = runCli(root, ['validate', 'full-plugin']);
  assertFails(drift, 'validate drift');
  assert.match(drift.output, /Codex manifest/);

  const badRoot = writeMarketplaceRoot('bad-ref');
  writeSkillPlugin(badRoot, 'bad-ref');
  const pluginYamlPath = join(badRoot, 'plugins/bad-ref/plugin.yaml');
  const yaml = readFileSync(pluginYamlPath, 'utf-8').replace('path: skills/bad-ref', 'path: ../escape');
  writeFileSync(pluginYamlPath, yaml);
  assertOk(runCli(badRoot, ['build', 'bad-ref']), 'build bad-ref');
  const badRef = runCli(badRoot, ['validate', 'bad-ref']);
  assertFails(badRef, 'validate bad reference');
  assert.match(badRef.output, /越过插件目录/);

  const symlinkRoot = writeMarketplaceRoot('validate-symlink');
  writeSkillPlugin(symlinkRoot, 'linked-skill');
  assertOk(runCli(symlinkRoot, ['build', 'linked-skill']), 'build linked-skill');
  const outsideSkill = join(symlinkRoot, 'outside-skill');
  mkdirSync(outsideSkill);
  writeFileSync(join(outsideSkill, 'SKILL.md'), '# Outside\n');
  symlinkSync(
    outsideSkill,
    join(symlinkRoot, 'plugins/linked-skill/skills/external'),
  );
  const linkedYamlPath = join(
    symlinkRoot,
    'plugins/linked-skill/plugin.yaml',
  );
  writeFileSync(
    linkedYamlPath,
    readFileSync(linkedYamlPath, 'utf-8').replace(
      'path: skills/linked-skill',
      'path: skills/external',
    ),
  );
  const linkedRef = runCli(symlinkRoot, ['validate', 'linked-skill']);
  assertFails(linkedRef, 'validate symlink reference');
  assert.match(linkedRef.output, /不允许使用符号链接/);
}

function testValidatePresentationCompatibility(): void {
  const root = writeMarketplaceRoot('validate-presentation');
  writeSkillPlugin(root, 'presentation-plugin');
  assertOk(runCli(root, ['build', 'presentation-plugin']), 'build presentation fixture');

  const ready = runCli(root, ['validate', 'presentation-plugin']);
  assertOk(ready, 'validate presentation ready');
  assert.equal(
    ready.output,
    `⟳ 验证 1 个插件...

  ✓ presentation-plugin

✓ 所有插件验证通过
`,
  );

  mkdirSync(join(root, 'plugins', 'unfinished-directory'));
  const all = runCli(root, ['validate', '--all']);
  assertOk(all, 'validate --all keeps existing plugin selection');
  assert.doesNotMatch(all.output, /unfinished-directory/);

  const missing = runCli(root, ['validate', 'missing-plugin']);
  assertFails(missing, 'validate missing selected plugin');
  assert.match(
    missing.output,
    /└─ 插件目录不存在: plugins\/missing-plugin/,
  );
  assert.match(missing.output, /✗ 存在验证错误/);
}

function testValidateSemanticSourceCompatibility(): void {
  const mismatchRoot = writeMarketplaceRoot("validate-name-mismatch");
  writeSkillPlugin(mismatchRoot, "name-mismatch");
  const mismatchYaml = join(
    mismatchRoot,
    "plugins/name-mismatch/plugin.yaml",
  );
  writeFileSync(
    mismatchYaml,
    readFileSync(mismatchYaml, "utf-8").replace(
      "name: name-mismatch",
      "name: canonical-name",
    ),
  );
  const mismatch = runCli(mismatchRoot, ["validate", "name-mismatch"]);
  assertFails(mismatch, "validate name mismatch with missing generated files");
  const mismatchPlugin = join(
    realpathSync(mismatchRoot),
    "plugins/name-mismatch",
  );
  assert.equal(
    mismatch.output,
    `⟳ 验证 1 个插件...

  ✗ name-mismatch
    └─ Agent Plugins manifest 缺失，请重新运行 build: ${join(mismatchPlugin, "plugin.json")}
    └─ Claude manifest 缺失，请重新运行 build: ${join(mismatchPlugin, ".claude-plugin/plugin.json")}
    └─ Codex manifest 缺失，请重新运行 build: ${join(mismatchPlugin, ".codex-plugin/plugin.json")}
    └─ plugin.yaml 中的 name (canonical-name) 与目录名 (name-mismatch) 不一致

✗ 存在验证错误
`,
  );

  const lspRoot = writeMarketplaceRoot("validate-lsp-semantic");
  writeFullPlugin(lspRoot);
  assertOk(runCli(lspRoot, ["build", "full-plugin"]), "build LSP fixture");
  const lspYaml = join(lspRoot, "plugins/full-plugin/plugin.yaml");
  writeFileSync(
    lspYaml,
    readFileSync(lspYaml, "utf-8")
      .replace('description: "Full plugin"', 'description: "Changed plugin"')
      .replace("startupTimeout: 30000", "startupTimeout: -1"),
  );
  const lsp = runCli(lspRoot, ["validate", "full-plugin"]);
  assertFails(lsp, "validate LSP semantic error with generated drift");
  const lspPlugin = join(realpathSync(lspRoot), "plugins/full-plugin");
  assert.equal(
    lsp.output,
    `⟳ 验证 1 个插件...

  ✗ full-plugin
    └─ LSP startupTimeout 不能为负数: demo
    └─ Agent Plugins manifest 与 plugin.yaml 派生结果不一致，请重新运行 build: ${join(lspPlugin, "plugin.json")}
    └─ Claude manifest 与 plugin.yaml 派生结果不一致，请重新运行 build: ${join(lspPlugin, ".claude-plugin/plugin.json")}
    └─ Codex manifest 与 plugin.yaml 派生结果不一致，请重新运行 build: ${join(lspPlugin, ".codex-plugin/plugin.json")}
    └─ LSP 配置 与 plugin.yaml 派生结果不一致，请重新运行 build: ${join(lspPlugin, ".lsp.json")}

✗ 存在验证错误
`,
  );
}

const tests: Array<[string, () => void]> = [
  ['help and version', testHelpAndVersion],
  ['init-repo', testInitRepo],
  ['init types build and validate', testInitTypesBuildAndValidate],
  ['add components', testAddComponents],
  ['import skill', testImportSkill],
  ['build index validate and release', testBuildIndexValidateAndRelease],
  ['Agent Plugins source schema validation', testAgentPluginsSourceSchemaValidation],
  ['Codex interface schema validation', testCodexInterfaceSchemaValidation],
  ['validate rejects drift and bad references', testValidateRejectsDriftAndBadReferences],
  ['validate presentation compatibility', testValidatePresentationCompatibility],
  ['validate semantic source compatibility', testValidateSemanticSourceCompatibility],
];

for (const [name, test] of tests) {
  test();
  console.log(`✓ ${name}`);
}
