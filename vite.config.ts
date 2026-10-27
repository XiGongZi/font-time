import path from 'node:path';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createGlyphApi } from './server/api.ts';

/**
 * 把字形 API 挂到 dev server 上。
 *
 * 这样 `npm run dev` 单进程就能同时提供页面和 /api/*，
 * 不用另开后端进程，也不用配 proxy。
 * 生产环境由 server/index.ts 提供同一套接口。
 */
function glyphApiPlugin(): Plugin {
  let apiPromise: ReturnType<typeof createGlyphApi> | null = null;

  return {
    name: 'font-time:glyph-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api/')) {
          next();
          return;
        }
        try {
          apiPromise ??= createGlyphApi(path.resolve(process.cwd(), 'data'));
          const handler = await apiPromise;
          await handler(req, res);
        } catch (error) {
          res.statusCode = 500;
          res.setHeader('content-type', 'application/json; charset=utf-8');
          res.end(JSON.stringify({ error: (error as Error).message }));
        }
      });
    },
  };
}

// 使用相对 base，构建产物可放在任意子路径。
export default defineConfig({
  plugins: [react(), glyphApiPlugin()],
  base: './',
  server: {
    port: 5173,
    // 端口被占用时自动换下一个可用端口
    strictPort: false,
    host: '127.0.0.1',
    watch: {
      // vendor/ 有 14 万个原始 SVG，data/ 有 1.5 万个字形文件，
      // 交给 chokidar 监听会吃掉大量文件句柄，直接排除
      ignored: ['**/vendor/**', '**/data/**', '**/scripts/.cache/**'],
    },
  },
  preview: {
    port: 4173,
    strictPort: false,
    host: '127.0.0.1',
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  test: {
    // 核心逻辑均为纯函数，用 node 环境即可
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
