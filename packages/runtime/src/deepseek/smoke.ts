import { DeepSeekProvider } from './provider.js';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  process.stderr.write('DEEPSEEK_API_KEY is not set; live smoke test skipped.\n');
  process.exitCode = 2;
} else {
  const provider = new DeepSeekProvider({ getApiKey: () => apiKey });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('DeepSeek smoke timeout')), 30_000);
  let text = '';
  let completed = false;
  try {
    for await (const event of provider.stream({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'Reply with exactly: Sci Workplace smoke ok' }],
      tools: [],
      thinking: 'disabled',
      reasoningEffort: 'low',
      maxOutputTokens: 32,
    }, controller.signal)) {
      if (event.type === 'text_delta') text += event.text;
      if (event.type === 'error') throw new Error(`${event.code}: ${event.message}`);
      if (event.type === 'done') completed = true;
    }
    if (!completed || !text.trim()) throw new Error('DeepSeek smoke returned no completed text');
    process.stdout.write(`DeepSeek live smoke: ok (${text.trim().length} chars)\n`);
  } finally {
    clearTimeout(timer);
  }
}
