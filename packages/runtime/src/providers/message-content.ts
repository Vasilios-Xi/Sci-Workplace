import type { MessageContent } from '@openlab/protocol';

export function openAiChatContent(content: MessageContent | null): unknown {
  if (content === null || typeof content === 'string') return content;
  return content.map((part) => part.type === 'text'
    ? { type: 'text', text: part.text }
    : { type: 'image_url', image_url: { url: part.imageUrl } });
}

export function ollamaChatContent(content: MessageContent | null): { content: string; images?: string[] } {
  if (content === null) return { content: '' };
  if (typeof content === 'string') return { content };
  const text: string[] = [];
  const images: string[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      text.push(part.text);
      continue;
    }
    const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/isu.exec(part.imageUrl);
    if (match?.[1]) images.push(match[1]);
    else text.push('[该图像 URL 不能由本地 Ollama 直接读取]');
  }
  return { content: text.join('\n'), ...(images.length > 0 ? { images } : {}) };
}
