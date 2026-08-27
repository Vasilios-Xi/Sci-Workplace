const META_TITLE_PATTERN = /(?:标题(?:生成|命名)(?:方法|规则|建议|指南)?|(?:生成|创建|拟定)(?:科研)?(?:会话|对话)?标题|^(?:科研)?(?:会话|对话)(?:标题|主题|概述)?$)/u;
const GREETING_PATTERN = /^(?:你好|您好|嗨|哈喽|hello|hi|hey)(?:[，,\s]+[\p{L}\p{N}_-]{1,10})?[!！。,.，?？~～]*$/iu;

function firstNonEmptyLine(value: string): string {
  return value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? '';
}

function takeCodePoints(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

export function sessionTitleFallback(input: string): string {
  const title = firstNonEmptyLine(input)
    .replace(/^[#>*\s-]+/u, '')
    .replace(/^\d+[.)、]\s*/u, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return takeCodePoints(title, 24) || '科研对话';
}

export function shouldRefineSessionTitle(input: string): boolean {
  const normalized = input.replace(/\s+/gu, ' ').trim();
  return Boolean(normalized) && !GREETING_PATTERN.test(normalized);
}

export function parseGeneratedSessionTitle(raw: string, fallback: string, input: string): string | undefined {
  let title = firstNonEmptyLine(raw)
    .replace(/^[#>*\s-]+/u, '')
    .replace(/^\d+[.)、]\s*/u, '')
    .replace(/^(?:会话|对话)?标题\s*[:：]\s*/u, '')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/[。.!！]+$/u, '');
  title = takeCodePoints(title, 18).trim();
  if (!title || title === fallback) return undefined;
  if (META_TITLE_PATTERN.test(title) && !META_TITLE_PATTERN.test(input)) return undefined;
  return title;
}

export function shouldRepairGeneratedSessionTitle(title: string, input: string): boolean {
  const fallback = sessionTitleFallback(input);
  return title !== fallback && parseGeneratedSessionTitle(title, fallback, input) === undefined;
}
