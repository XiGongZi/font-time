/**
 * 字形查询 API。
 *
 * 全量字形有 2.7 万个文件、50MB+，不适合整体塞给浏览器，
 * 所以由 node 侧按字分发：前端只请求当前文本用到的字。
 *
 * 路由：
 *   GET /api/manifest            数据清单（元信息 + 阶段顺序 + 有数据的字表）
 *   GET /api/glyphs?chars=日月山水  批量取字（推荐，一次请求拿多个）
 *   GET /api/glyph/日             单字
 *   GET /api/health              健康检查
 *
 * 既可以被独立 server（server/index.ts）使用，
 * 也可以挂到 vite dev server 的中间件上（见 vite.config.ts）。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

/** 单次批量请求最多取多少字，防止有人一次拉全量。 */
const MAX_BATCH = 200;
/** 内存缓存上限（字）。超过后整体清空，简单但足够。 */
const CACHE_LIMIT = 4000;

export interface GlyphManifestPayload {
  meta: Record<string, unknown>;
  stageOrder: string[];
  chars: string;
  split: boolean;
}

interface GlyphStore {
  manifest: GlyphManifestPayload;
  charSet: Set<string>;
  cache: Map<string, string>;
}

/** 字 → 分片文件名（码位大写十六进制，补足 6 位），与构建脚本保持一致。 */
function glyphFileName(char: string): string {
  const cp = char.codePointAt(0) ?? 0;
  return `${cp.toString(16).toUpperCase().padStart(6, '0')}.json`;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  // 字形数据是静态的，允许浏览器缓存一段时间
  res.setHeader('cache-control', 'public, max-age=3600');
  res.end(payload);
}

/**
 * 创建 API 处理器。
 *
 * @param dataDir 构建脚本产出的数据目录（含 manifest.json 与 glyphs/）
 */
export async function createGlyphApi(dataDir: string) {
  const manifestPath = path.join(dataDir, 'manifest.json');
  let store: GlyphStore | null = null;
  let loadError: string | null = null;

  async function getStore(): Promise<GlyphStore> {
    if (store) return store;

    const raw = await fs.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as GlyphManifestPayload;
    store = {
      manifest,
      charSet: new Set(Array.from(manifest.chars)),
      cache: new Map(),
    };
    return store;
  }

  // 启动时预加载清单，尽早暴露「数据没构建」的问题
  try {
    const s = await getStore();
    console.log(
      `[glyph-api] 已加载 ${s.manifest.meta.charCount ?? s.charSet.size} 字清单` +
        `（${path.relative(process.cwd(), manifestPath)}）`,
    );
  } catch (error) {
    loadError = (error as Error).message;
    console.warn(`[glyph-api] 未能加载 ${manifestPath}：${loadError}`);
    console.warn('[glyph-api] 请先执行 npm run data:build -- --all --local=<仓库路径>');
  }

  async function readGlyph(s: GlyphStore, char: string): Promise<string | null> {
    if (!s.charSet.has(char)) return null;

    const cached = s.cache.get(char);
    if (cached) return cached;

    try {
      const text = await fs.readFile(path.join(dataDir, 'glyphs', glyphFileName(char)), 'utf8');
      if (s.cache.size > CACHE_LIMIT) s.cache.clear();
      s.cache.set(char, text);
      return text;
    } catch {
      // 清单里有、文件却缺失：当作没有，不要让整个请求失败
      return null;
    }
  }

  /** 返回 true 表示已处理该请求，false 表示交给后续中间件。 */
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;

    if (loadError) {
      sendJson(res, 503, {
        error: 'glyph data not built',
        detail: loadError,
        hint: 'npm run data:build -- --all --local=<hanzi-glyphs-svg 仓库路径>',
      });
      return true;
    }

    try {
      if (url.pathname === '/api/health') {
        const s = await getStore();
        sendJson(res, 200, { ok: true, chars: s.charSet.size });
        return true;
      }

      if (url.pathname === '/api/manifest') {
        const s = await getStore();
        // 清单里不含字形，只有字表与元信息
        sendJson(res, 200, { ...s.manifest, split: true });
        return true;
      }

      if (url.pathname === '/api/glyphs') {
        const s = await getStore();
        const raw = url.searchParams.get('chars') ?? '';
        const chars = [...new Set(Array.from(raw))].filter((char) => char.trim() !== '');

        if (chars.length === 0) {
          sendJson(res, 400, { error: 'missing chars' });
          return true;
        }
        if (chars.length > MAX_BATCH) {
          sendJson(res, 413, { error: `too many chars (max ${MAX_BATCH})` });
          return true;
        }

        const result: Record<string, unknown> = {};
        await Promise.all(
          chars.map(async (char) => {
            const text = await readGlyph(s, char);
            result[char] = text ? JSON.parse(text) : null;
          }),
        );
        sendJson(res, 200, result);
        return true;
      }

      if (url.pathname.startsWith('/api/glyph/')) {
        const s = await getStore();
        const char = decodeURIComponent(url.pathname.slice('/api/glyph/'.length));
        if (!char) {
          sendJson(res, 400, { error: 'missing char' });
          return true;
        }
        const text = await readGlyph(s, char);
        if (!text) {
          sendJson(res, 404, { error: 'no glyph data', char });
          return true;
        }
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json; charset=utf-8');
        res.setHeader('cache-control', 'public, max-age=3600');
        res.end(text);
        return true;
      }

      sendJson(res, 404, { error: 'unknown api route' });
      return true;
    } catch (error) {
      sendJson(res, 500, { error: (error as Error).message });
      return true;
    }
  };
}
