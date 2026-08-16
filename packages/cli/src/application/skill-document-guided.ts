import type {
  SkillGuidedSection,
  SkillGuidedSectionKey,
} from "./skill-document-contract.js";

const guidedLabels: Readonly<Record<SkillGuidedSectionKey, string>> = {
  "when-to-use": "何时使用",
  outcome: "要完成什么",
  execution: "如何执行",
  inputs: "需要什么输入",
};

export function skillGuidedSections(body: string): readonly SkillGuidedSection[] {
  const headings: { key: SkillGuidedSectionKey; start: number; contentStart: number }[] = [];
  const pattern = /^##[ \t]+(何时使用|要完成什么|如何执行|需要什么输入)[ \t]*\r?$/gm;
  for (const match of body.matchAll(pattern)) {
    const label = match[1]!;
    const key = (Object.entries(guidedLabels).find(([, value]) => value === label)?.[0] ?? "") as SkillGuidedSectionKey;
    headings.push({
      key,
      start: match.index!,
      contentStart: match.index! + match[0].length + (body.slice(match.index! + match[0].length).startsWith("\n") ? 1 : 0),
    });
  }
  const boundaries = [...body.matchAll(/^#{1,2}[ \t]+.+$/gm)].map((match) => match.index!);
  return (Object.keys(guidedLabels) as SkillGuidedSectionKey[]).map((key) => {
    const heading = headings.find((entry) => entry.key === key);
    if (heading === undefined) return { key, label: guidedLabels[key], present: false, content: "" };
    const end = boundaries.find((candidate) => candidate > heading.start) ?? body.length;
    return {
      key,
      label: guidedLabels[key],
      present: true,
      content: body.slice(heading.contentStart, end).replace(/^[\r\n]+|[\r\n]+$/g, ""),
    };
  });
}

export function updateSkillGuidedSection(
  body: string,
  key: SkillGuidedSectionKey,
  content: string,
  preferredLineEnding?: "lf" | "crlf",
): string {
  const eol = preferredLineEnding === "crlf" || body.includes("\r\n") ? "\r\n" : "\n";
  const label = guidedLabels[key];
  const headingPattern = new RegExp(
    `^##[ \\t]+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[ \\t]*\\r?$`,
    "m",
  );
  const match = headingPattern.exec(body);
  const normalizedContent = content.replace(/\r\n|\r|\n/g, eol).replace(/^[\r\n]+|[\r\n]+$/g, "");
  if (match === null) {
    const prefix = body.length === 0 ? "" : body.endsWith("\n") ? (body.endsWith(`${eol}${eol}`) ? "" : eol) : `${eol}${eol}`;
    return `${body}${prefix}## ${label}${eol}${eol}${normalizedContent}${eol}`;
  }
  const contentStart = match.index + match[0].length + (body.slice(match.index + match[0].length).startsWith("\n") ? 1 : 0);
  const nextHeading = /^#{1,2}[ \t]+.+$/gm;
  nextHeading.lastIndex = contentStart;
  const next = nextHeading.exec(body);
  const end = next?.index ?? body.length;
  const existing = body.slice(contentStart, end);
  const leading = existing.match(/^[\r\n]*/)?.[0] ?? "";
  const trailing = existing.match(/[\r\n]*$/)?.[0] ?? "";
  return `${body.slice(0, contentStart)}${leading}${normalizedContent}${trailing || eol}${body.slice(end)}`;
}
