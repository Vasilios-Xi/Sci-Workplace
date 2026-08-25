export async function* parseSseData(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const maxBufferedCharacters = 4 * 1024 * 1024;
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      if (buffer.length > maxBufferedCharacters && !buffer.includes('\n\n')) throw new Error('DeepSeek SSE 单帧超过 4 MB 上限');
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        if (boundary > maxBufferedCharacters) throw new Error('DeepSeek SSE 单帧超过 4 MB 上限');
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) yield data;
        boundary = buffer.indexOf('\n\n');
      }
      if (buffer.length > maxBufferedCharacters) throw new Error('DeepSeek SSE 单帧超过 4 MB 上限');
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      const data = tail
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
  } finally {
    reader.releaseLock();
  }
}
