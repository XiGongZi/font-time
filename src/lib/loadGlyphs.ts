/**
 * 字形数据加载。
 *
 * 三种取数路径，按优先级自动选择，调用方不需要关心：
 *
 *   1. `GET /api/manifest` + `GET /api/glyphs?chars=…`
 *      —— node 后端按需分发（全量 1.5 万字时的推荐方式，见 server/api.ts）
 *   2. `data/manifest.json` + `data/glyphs/<码位>.json`
 *      —— 纯静态部署的分字形态
 *   3. `data/glyphs.json`
 *      —— 小字集单文件，一次请求拿全部
 */
import type { GlyphEntry, GlyphManifest } from './types';

const BASE = import.meta.env.BASE_URL;
/** 服务端单次批量请求上限，与 server/api.ts 的 MAX_BATCH 保持一致。 */
const API_BATCH_LIMIT = 200;

let manifestPromise: Promise<GlyphManifest> | null = null;
/** 单字加载结果缓存（含「确实没有这个字」的 null，避免重复请求）。 */
const glyphCache = new Map<string, Promise<GlyphEntry | null>>();
/** 有数据的字集合，由 manifest.chars 构建一次。 */
let charSetCache: { source: string; set: Set<string> } | null = null;

/** 字 → 分片文件名（码位大写十六进制，补足 6 位）。 */
export function glyphFileName(char: string): string {
  const cp = char.codePointAt(0) ?? 0;
  return `${cp.toString(16).toUpperCase().padStart(6, '0')}.json`;
}

/** 判断响应是不是 JSON（纯静态部署时 /api/* 可能被 SPA fallback 成 HTML）。 */
function isJson(response: Response): boolean {
  return (response.headers.get('content-type') ?? '').includes('application/json');
}

/** 加载数据清单（带进程内缓存）。 */
export function loadManifest(): Promise<GlyphManifest> {
  if (!manifestPromise) {
    manifestPromise = (async (): Promise<GlyphManifest> => {
      // 1) 后端 API
      try {
        const apiResponse = await fetch(`${BASE}api/manifest`);
        if (apiResponse.ok && isJson(apiResponse)) {
          const data = (await apiResponse.json()) as GlyphManifest;
          return { ...data, api: true };
        }
      } catch {
        // 没有后端，走静态
      }

      // 2) 静态分字清单
      const manifestResponse = await fetch(`${BASE}data/manifest.json`);
      if (manifestResponse.ok && isJson(manifestResponse)) {
        return (await manifestResponse.json()) as GlyphManifest;
      }

      // 3) 静态单文件
      const legacyResponse = await fetch(`${BASE}data/glyphs.json`);
      if (!legacyResponse.ok) {
        throw new Error(
          '字形数据加载失败：既没有 /api/manifest，也没有 data/glyphs.json。' +
            '请执行 npm run setup 或 npm run data:build',
        );
      }
      return (await legacyResponse.json()) as GlyphManifest;
    })().catch((error: unknown) => {
      manifestPromise = null;
      throw error instanceof Error ? error : new Error(String(error));
    });
  }
  return manifestPromise;
}

/** 该字是否有字形数据（不发起网络请求）。 */
export function hasGlyph(manifest: GlyphManifest, char: string): boolean {
  if (charSetCache?.source !== manifest.chars) {
    charSetCache = { source: manifest.chars, set: new Set(Array.from(manifest.chars)) };
  }
  return charSetCache.set.has(char);
}

/** 按字加载字形；没有数据时返回 null（不会抛错）。 */
export async function loadGlyph(
  manifest: GlyphManifest,
  char: string,
): Promise<GlyphEntry | null> {
  // 内联形态：直接从清单里取
  if (manifest.glyphs) return manifest.glyphs[char] ?? null;

  if (!hasGlyph(manifest, char)) return null;

  const cached = glyphCache.get(char);
  if (cached) return cached;

  const url = manifest.api
    ? `${BASE}api/glyph/${encodeURIComponent(char)}`
    : `${BASE}data/glyphs/${glyphFileName(char)}`;

  const request = fetch(url)
    .then(async (response) => {
      if (!response.ok) return null;
      return (await response.json()) as GlyphEntry;
    })
    .catch(() => {
      // 网络抖动：清掉缓存，下次还能重试
      glyphCache.delete(char);
      return null;
    });

  glyphCache.set(char, request);
  return request;
}

/**
 * 批量加载。
 *
 * - 后端模式：一次请求拿多个字（`/api/glyphs?chars=日月山水`），省掉 N 次往返；
 * - 静态模式：限制并发逐个取，避免浏览器连接池被塞满。
 */
export async function loadGlyphsBatch(
  manifest: GlyphManifest,
  chars: string[],
  concurrency = 6,
): Promise<Map<string, GlyphEntry | null>> {
  const result = new Map<string, GlyphEntry | null>();
  const unique = [...new Set(chars)];
  if (unique.length === 0) return result;

  if (manifest.glyphs) {
    for (const char of unique) result.set(char, manifest.glyphs[char] ?? null);
    return result;
  }

  if (manifest.api) {
    for (let start = 0; start < unique.length; start += API_BATCH_LIMIT) {
      const chunk = unique.slice(start, start + API_BATCH_LIMIT);
      try {
        const response = await fetch(
          `${BASE}api/glyphs?chars=${encodeURIComponent(chunk.join(''))}`,
        );
        if (!response.ok) {
          for (const char of chunk) result.set(char, null);
          continue;
        }
        const data = (await response.json()) as Record<string, GlyphEntry | null>;
        for (const char of chunk) result.set(char, data[char] ?? null);
      } catch {
        for (const char of chunk) result.set(char, null);
      }
    }
    return result;
  }

  // 静态分字形态
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, unique.length) }, async () => {
    while (cursor < unique.length) {
      const index = cursor;
      cursor += 1;
      const char = unique[index];
      result.set(char, await loadGlyph(manifest, char));
    }
  });
  await Promise.all(workers);
  return result;
}

/** 仅用于测试或强制刷新。 */
export function resetGlyphCache(): void {
  manifestPromise = null;
  glyphCache.clear();
  charSetCache = null;
}
