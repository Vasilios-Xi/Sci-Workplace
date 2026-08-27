import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: {
    target: 'chrome140',
    sourcemap: true,
    rolldownOptions: {
      output: {
        // Keep the initial renderer parse cost bounded even as the settings,
        // Markdown and Worktable surfaces grow.
        codeSplitting: {
          groups: [
            { name: 'react', test: /node_modules[\\/](?:react|react-dom|scheduler)[\\/]/u },
            { name: 'icons', test: /node_modules[\\/]lucide-react[\\/]/u },
            {
              name: 'markdown',
              test: /node_modules[\\/](?:react-markdown|remark-|rehype-|unified|katex|mdast-|hast-|micromark|property-information|vfile|unist-util)/u,
            },
          ],
        },
      },
    },
  },
});
