/**
 * 生产环境服务端。
 *
 * 同时承担两件事：
 *   1. /api/*  —— 字形按需分发（见 server/api.ts）
 *   2. 其余路径 —— 提供 dist/ 里的静态文件（SPA fallback 到 index.html）
 *
 * 用法：
 *   npm run build && npm run start
 *   PORT=8080 npm run start
 */
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGlyphApi } from './api.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DIST = path.join(ROOT, 'dist');
const DATA = path.join(ROOT, 'data');

const START_PORT = Number(process.env.PORT) || 5174;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** 解析静态文件请求，带目录穿越防护。 */
async function serveStatic(
  urlPath: string,
  res: http.ServerResponse,
): Promise<void> {
  const decoded = decodeURIComponent(urlPath);
  const resolved = path.resolve(DIST, `.${decoded}`);

  // 目录穿越防护：必须落在 dist 内
  const inDist = resolved === DIST || resolved.startsWith(DIST + path.sep);
  const target = inDist ? resolved : path.join(DIST, 'index.html');

  let filePath = target;
  try {
    const stat = await fsp.stat(filePath);
    if (stat.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    // 找不到就回落到 SPA 入口
    filePath = path.join(DIST, 'index.html');
  }

  try {
    const ext = path.extname(filePath).toLowerCase();
    const data = await fsp.readFile(filePath);
    res.statusCode = 200;
    res.setHeader('content-type', MIME[ext] ?? 'application/octet-stream');
    // 带 hash 的静态资源可以长缓存，html 不缓存
    res.setHeader(
      'cache-control',
      ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.setHeader('content-type', 'text/plain; charset=utf-8');
    res.end('404 Not Found\n\n请先执行 npm run build 生成 dist/');
  }
}

async function main(): Promise<void> {
  if (!fs.existsSync(DIST)) {
    console.warn('[server] 未找到 dist/，静态文件不可用；请先 npm run build');
  }

  const api = await createGlyphApi(DATA);

  const server = http.createServer(async (req, res) => {
    try {
      if (await api(req, res)) return;
      await serveStatic(new URL(req.url ?? '/', 'http://localhost').pathname, res);
    } catch (error) {
      console.error('[server] 请求处理失败：', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal Server Error');
      }
    }
  });

  // 端口被占用时自动换下一个
  const listen = (port: number): void => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        console.warn(`[server] 端口 ${port} 被占用，尝试 ${port + 1}`);
        listen(port + 1);
      } else {
        console.error('[server] 启动失败：', error);
        process.exitCode = 1;
      }
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[server] 已启动：http://127.0.0.1:${port}`);
    });
  };

  listen(START_PORT);
}

main().catch((error: unknown) => {
  console.error('[server] 未捕获错误：', error);
  process.exitCode = 1;
});
