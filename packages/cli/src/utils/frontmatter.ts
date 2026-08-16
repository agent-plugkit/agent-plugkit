/**
 * Markdown frontmatter 最小解析器
 *
 * 不为 frontmatter 解析引入 gray-matter 之类的额外第三方库。这里只解析 SKILL.md 的 `---`
 * YAML 头块，用现有 js-yaml 处理块内容。
 *
 * 与 utils/ 层其余文件一样：不引入 chalk/console，不抛业务错误。调用方（命令层）拥有文件路径
 * 上下文，应由它拼出面向用户的中文错误文案。
 *
 * 已知取舍：frontmatter 块内若使用 YAML 块标量（| 或 >）且块内容含独立的 `---` 行，会被
 * 提前当作闭合分隔符截断，退化为 invalid-yaml。这是刻意的最小实现，不做 YAML 流式扫描。
 */

import yaml from 'js-yaml';

export type FrontmatterFailure =
  | { kind: 'unterminated' }
  | { kind: 'invalid-yaml'; message: string }
  | { kind: 'not-object' };

export type FrontmatterResult =
  | { ok: true; present: boolean; data: Record<string, unknown> }
  | { ok: false; failure: FrontmatterFailure };

const DELIMITER = '---';

function stripBom(raw: string): string {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

export function parseFrontmatter(raw: string): FrontmatterResult {
  const normalized = stripBom(raw);
  const lines = normalized.split('\n').map((line) => line.replace(/\r$/, ''));

  if (lines.length === 0 || lines[0].trimEnd() !== DELIMITER) {
    return { ok: true, present: false, data: {} };
  }

  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trimEnd() === DELIMITER) {
      closingIndex = i;
      break;
    }
  }

  if (closingIndex === -1) {
    return { ok: false, failure: { kind: 'unterminated' } };
  }

  const block = lines.slice(1, closingIndex).join('\n');

  let parsed: unknown;
  try {
    parsed = yaml.load(block);
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'invalid-yaml', message: (err as Error).message },
    };
  }

  if (parsed === undefined || parsed === null) {
    return { ok: true, present: true, data: {} };
  }

  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, failure: { kind: 'not-object' } };
  }

  return { ok: true, present: true, data: parsed as Record<string, unknown> };
}

export function frontmatterString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
