/**
 * scripts/build-glyphs.ts
 * ---------------------------------------------------------------------------
 * 从开源汉字字形库 zhouyongh/hanzi-glyphs-svg 抽取一个常用字集合，
 * 归一化后输出 public/data/glyphs.json，供前端静态加载。
 *
 * 设计要点：
 * 1. 只抽取需要的那几十个字，绝不打包全量库（全库 14 万+ 字形）。
 * 2. 分书体取数：oracle / bronze / seal / clerical / kaishu 五层，
 *    每层用 index.csv 反查「现代字 → 字形文件」。
 * 3. 所有 SVG 统一归一化到 viewBox="0 0 100 100"，颜色改为 currentColor，
 *    这样前端不需要为不同来源写不同的适配代码。
 * 4. 网络不可用时自动降级为内置占位图形（明确标记 placeholder，不冒充真实字形）。
 *
 * 用法：
 *   npx tsx scripts/build-glyphs.ts                       # 默认 20 字（带本地缓存）
 *   npx tsx scripts/build-glyphs.ts --all                 # 全量（五层并集约 1.5 万字）
 *   npx tsx scripts/build-glyphs.ts --add=天地玄黄         # 在默认 20 字上追加
 *   npx tsx scripts/build-glyphs.ts --chars=天地玄黄       # 只用这组字替换默认字集
 *   npx tsx scripts/build-glyphs.ts --refresh             # 忽略缓存重新抓取
 *   npx tsx scripts/build-glyphs.ts --offline             # 强制使用内置占位数据
 *
 * 全量抓取有 2.7 万个文件，走 HTTP 很慢（实测约 6-7 个/秒，需 1 小时以上）。
 * 推荐先克隆仓库再本地构建，几十秒即可完成：
 *   git clone --depth 1 https://github.com/zhouyongh/hanzi-glyphs-svg /tmp/hanzi-glyphs-svg
 *   npx tsx scripts/build-glyphs.ts --all --local=/tmp/hanzi-glyphs-svg
 *
 * 也可以写成 npm 形式：npm run data:build -- --add=天地玄黄
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 路径与常量
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE_DIR = path.join(HERE, '.cache');
const PUBLIC_DATA_DIR = path.join(ROOT, 'public', 'data');
/** 后端模式的数据目录（不参与 vite 静态构建，由 server/ 读取） */
const SERVER_DATA_DIR = path.join(ROOT, 'data');

/** 小字集走单文件（一次请求拿全），放 public/ 供纯静态部署 */
const OUT_FILE = path.join(PUBLIC_DATA_DIR, 'glyphs.json');
/** 全量走按字分文件，放 data/ 由 node 后端分发 */
const MANIFEST_FILE = path.join(SERVER_DATA_DIR, 'manifest.json');
const SPLIT_DIR = path.join(SERVER_DATA_DIR, 'glyphs');

/** 字数不超过这个值就内联进 manifest，省掉 N 次请求。 */
const INLINE_LIMIT = 300;
/** 全量抓取时每批处理的字数，控制内存峰值。 */
const BATCH_SIZE = 200;

const REPO = 'zhouyongh/hanzi-glyphs-svg';
const BRANCH = 'main';
const REPO_URL = `https://github.com/${REPO}`;

/** 默认抽取的常用字（需求指定的 20 字）。可用 --chars / --add 覆盖或追加。 */
const DEFAULT_CHARS = [...'日月山水人木火土口手目耳心大小上下中田雨'];

/**
 * 解析命令行里的字集参数。
 *
 *   --all              抓五层并集里的**全部**字（约 1.5 万字，无需手动维护字表）
 *   --chars=天地玄黄   完全使用这组字（替换默认 20 字）
 *   --add=天地玄黄     在默认 20 字基础上追加
 *
 * 优先级：--all > --chars > 默认字集；--add 始终追加。
 * 会自动去重、剔除空白与标点、按出现顺序保序。
 */
function resolveTargetChars(argv: string[]): { chars: string[] | null; source: string } {
  const readFlag = (name: string): string | null => {
    const prefix = `--${name}=`;
    const hit = argv.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : null;
  };

  const charsArg = readFlag('chars');
  const addArg = readFlag('add');

  // --all：chars 返回 null，表示「等索引读完再决定」，避免先去扫一遍 CSV
  if (argv.includes('--all')) {
    return { chars: null, source: '--all 全量（五层并集）' };
  }

  if (!charsArg && !addArg) {
    return { chars: DEFAULT_CHARS, source: '默认字集' };
  }

  const base = charsArg ? splitChars(charsArg) : DEFAULT_CHARS;
  const extra = addArg ? splitChars(addArg) : [];
  const merged = [...new Set([...base, ...extra])];

  return {
    chars: merged,
    source: charsArg ? `--chars 指定` : `默认字集 + --add 追加`,
  };
}

/** 把一串文本拆成去重后的汉字数组。 */
function splitChars(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const char of Array.from(text)) {
    if (!/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[\u{20000}-\u{2FA1F}]/u.test(char)) continue;
    if (seen.has(char)) continue;
    seen.add(char);
    out.push(char);
  }
  return out;
}

/** 数据源分支名 → 阶段名的映射，era 为数据源缺 period 时的兜底年代。 */
interface LayerConfig {
  id: string;
  /** 阶段名，取数据源实际书体名 */
  name: string;
  /** 兜底年代 */
  era: string;
  /** 仓库内目录 */
  dir: string;
}

const LAYERS: LayerConfig[] = [
  { id: 'oracle', name: '甲骨文', era: '商', dir: 'glyphs/oracle' },
  { id: 'bronze', name: '金文', era: '周', dir: 'glyphs/bronze' },
  { id: 'seal', name: '小篆', era: '秦', dir: 'glyphs/seal' },
  { id: 'clerical', name: '隶书', era: '汉', dir: 'glyphs/clerical' },
  { id: 'kaishu', name: '楷书', era: '今', dir: 'glyphs/kaishu' },
];

/**
 * 访问 raw 文件的镜像链。
 * 实测在部分网络环境下 raw.githubusercontent.com 不可达，故依次回退；
 * 也可用环境变量 GLYPH_SOURCE_BASE 指向自建镜像（形如 https://host/<repo>/<branch>）。
 */
const MIRRORS: Array<(relPath: string) => string> = [
  (p) => `https://raw.githubusercontent.com/${REPO}/${BRANCH}/${p}`,
  (p) => `https://gh-proxy.com/https://raw.githubusercontent.com/${REPO}/${BRANCH}/${p}`,
  (p) => `https://ghproxy.net/https://raw.githubusercontent.com/${REPO}/${BRANCH}/${p}`,
  (p) => `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/${p}`,
];

if (process.env.GLYPH_SOURCE_BASE) {
  const base = process.env.GLYPH_SOURCE_BASE.replace(/\/+$/, '');
  MIRRORS.unshift((p) => `${base}/${p}`);
}

const FETCH_TIMEOUT_MS = 45_000;
const CONCURRENCY = 4;
/** 全量抓取时用更高的并发（实测 24 并发约 17-25 个/秒）。 */
const BULK_CONCURRENCY = 24;

/** --local 指定的本地仓库根目录；非空时不走网络，直接读磁盘。 */
let LOCAL_ROOT: string | null = null;

// ---------------------------------------------------------------------------
// 类型（与 src/lib/types.ts 保持一致）
// ---------------------------------------------------------------------------

interface GlyphStage {
  name: string;
  era: string;
  svg: string;
  source?: string;
  placeholder?: boolean;
}

interface GlyphEntry {
  char: string;
  stages: GlyphStage[];
}

interface GlyphDatasetMeta {
  mode: 'real' | 'fallback';
  source: string;
  sourceUrl: string;
  license: string;
  generatedAt: string;
  charCount: number;
  stageCount: number;
  note?: string;
}

type CsvRow = Record<string, string>;

// ---------------------------------------------------------------------------
// 网络与缓存
// ---------------------------------------------------------------------------

/** 记录本次实际使用的镜像，写进 meta.note 便于排查。 */
const usedMirrors = new Set<string>();

async function readCache(relPath: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(CACHE_DIR, relPath), 'utf8');
  } catch {
    return null;
  }
}

async function writeCache(relPath: string, content: string): Promise<void> {
  const target = path.join(CACHE_DIR, relPath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, 'utf8');
}

/** 依次尝试镜像链拉取文本，成功即写缓存。全部失败则抛错。 */
async function fetchFromSource(relPath: string, refresh: boolean): Promise<string> {
  // 本地仓库模式（--local）：直接读磁盘，适合全量构建
  if (LOCAL_ROOT) {
    return fs.readFile(path.join(LOCAL_ROOT, relPath), 'utf8');
  }

  if (!refresh) {
    const cached = await readCache(relPath);
    if (cached !== null) return cached;
  }

  const errors: string[] = [];
  for (const build of MIRRORS) {
    const url = build(relPath);
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'user-agent': 'font-time-build-script' },
      });
      if (!response.ok) {
        errors.push(`${response.status} ${new URL(url).host}`);
        continue;
      }
      const text = await response.text();
      if (!text.trim()) {
        errors.push(`empty ${new URL(url).host}`);
        continue;
      }
      usedMirrors.add(new URL(url).host);
      await writeCache(relPath, text);
      return text;
    } catch (error) {
      errors.push(`${(error as Error).name} ${new URL(url).host}`);
    }
  }
  throw new Error(`无法获取 ${relPath}（已尝试 ${MIRRORS.length} 个镜像）：${errors.join('; ')}`);
}

/** 简单的并发池。 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index]);
    }
  });

  await Promise.all(runners);
  return results;
}

// ---------------------------------------------------------------------------
// CSV 解析（RFC4180 兼容，字段内可含逗号与引号）
// ---------------------------------------------------------------------------

function parseCsv(text: string): CsvRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const header = rows.shift() ?? [];
  return rows
    .filter((cells) => cells.some((cell) => cell.trim() !== ''))
    .map((cells) => {
      const record: CsvRow = {};
      header.forEach((key, index) => {
        record[key.trim()] = (cells[index] ?? '').trim();
      });
      return record;
    });
}

// ---------------------------------------------------------------------------
// SVG 归一化
// ---------------------------------------------------------------------------

const CANVAS = 100;
const PADDING = 6;

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function readViewBox(attrs: string): [number, number, number, number] {
  const matched = attrs.match(/viewBox\s*=\s*["']([^"']+)["']/i);
  if (matched) {
    const nums = matched[1].trim().split(/[\s,]+/).map(Number);
    if (nums.length === 4 && nums.every(Number.isFinite) && nums[2] > 0 && nums[3] > 0) {
      return [nums[0], nums[1], nums[2], nums[3]];
    }
  }
  // 退而求其次：用 width/height 构造
  const width = Number(attrs.match(/\bwidth\s*=\s*["']([\d.]+)/i)?.[1]);
  const height = Number(attrs.match(/\bheight\s*=\s*["']([\d.]+)/i)?.[1]);
  if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
    return [0, 0, width, height];
  }
  return [0, 0, 100, 100];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 多个内联 SVG 同处一页时，避免 defs/id 冲突。 */
function namespaceIds(body: string, suffix: string): string {
  if (!/\bid\s*=/.test(body)) return body;

  const ids = new Set<string>();
  body.replace(/\bid\s*=\s*"([^"]+)"/g, (_match, id: string) => {
    ids.add(id);
    return _match;
  });

  let output = body;
  for (const id of ids) {
    const safe = `${id}--${suffix}`;
    const pattern = escapeRegExp(id);
    output = output
      .replace(new RegExp(`id\\s*=\\s*"${pattern}"`, 'g'), `id="${safe}"`)
      .replace(new RegExp(`url\\(#${pattern}\\)`, 'g'), `url(#${safe})`)
      .replace(new RegExp(`(href\\s*=\\s*)"#${pattern}"`, 'g'), `$1"#${safe}"`);
  }
  return output;
}

/**
 * 把任意来源的 SVG 归一化为 0 0 100 100 画布：
 * - 优先用「实际墨迹包围盒」而非声明 viewBox 做缩放，保证每个字都居中铺满
 *   （汉典等来源的 400×400 画布里，字形实际只占很小一块）；
 * - 所有颜色替换为 currentColor，交给 CSS 控制深浅；
 * - 保留 fill="none" / url(#...) 等语义性取值。
 */
function normalizeSvg(raw: string, idSuffix: string): string {
  const cleaned = raw
    .replace(/<\?xml[^>]*\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .trim();

  const openTag = cleaned.match(/<svg\b([^>]*)>/i);
  if (!openTag || openTag.index === undefined) {
    throw new Error('SVG 缺少 <svg> 根节点');
  }

  const attrs = openTag[1];
  const inner = cleaned
    .slice(openTag.index + openTag[0].length)
    .replace(/<\/svg\s*>\s*$/i, '');

  const declaredViewBox = readViewBox(attrs);

  let body = inner
    .replace(/\b(fill|stroke)\s*=\s*"([^"]*)"/gi, (match, attr: string, value: string) => {
      const normalized = value.trim().toLowerCase();
      if (!normalized || normalized === 'none' || normalized === 'currentcolor') return match;
      if (normalized.startsWith('url(')) return match;
      return `${attr}="currentColor"`;
    })
    .replace(/\b(fill|stroke)\s*=\s*'([^']*)'/gi, (match, attr: string, value: string) => {
      const normalized = value.trim().toLowerCase();
      if (!normalized || normalized === 'none' || normalized === 'currentcolor') return match;
      if (normalized.startsWith('url(')) return match;
      return `${attr}="currentColor"`;
    });

  body = namespaceIds(body, idSuffix);

  // 用真实墨迹包围盒做基准；算不出来或明显异常时退回声明的 viewBox
  const contentBox = computeContentBBox(body, declaredViewBox);
  const [vx, vy, vw, vh]: [number, number, number, number] = contentBox
    ? [
        contentBox.minX,
        contentBox.minY,
        contentBox.maxX - contentBox.minX,
        contentBox.maxY - contentBox.minY,
      ]
    : declaredViewBox;

  const innerSize = CANVAS - PADDING * 2;
  const scale = Math.min(innerSize / vw, innerSize / vh);
  const dx = PADDING + (innerSize - vw * scale) / 2 - vx * scale;
  const dy = PADDING + (innerSize - vh * scale) / 2 - vy * scale;
  const transform = `translate(${round(dx)} ${round(dy)}) scale(${round(scale, 6)})`;

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" ` +
    `fill="currentColor" preserveAspectRatio="xMidYMid meet">` +
    `<g transform="${transform}">${body}</g></svg>`
  );
}

// ---------------------------------------------------------------------------
// 墨迹包围盒：解析 path / rect / circle / ellipse 的几何范围
// ---------------------------------------------------------------------------

interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const NUMBER_TOKEN = /[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g;

function isNumberToken(token: string): boolean {
  return /^[-+.\d]/.test(token);
}

function readAttr(attrs: string, name: string): number | null {
  const matched = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  if (!matched) return null;
  const value = Number.parseFloat(matched[1]);
  return Number.isFinite(value) ? value : null;
}

/**
 * 解析 path 的 d 属性，返回所有锚点与控制点的包围盒。
 * 控制点会略微放大包围盒（保守估计），对本项目「居中铺满」的用途完全够用。
 */
function pathBBox(d: string): BBox | null {
  const tokens = d.match(NUMBER_TOKEN);
  if (!tokens) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  const add = (px: number, py: number) => {
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  };

  let index = 0;
  let command = '';
  let cursorX = 0;
  let cursorY = 0;
  let startX = 0;
  let startY = 0;

  const take = (): number => {
    const token = tokens[index++];
    const value = Number.parseFloat(token ?? '0');
    return Number.isFinite(value) ? value : 0;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (!isNumberToken(token)) {
      command = token;
      index += 1;
      if (command === 'z' || command === 'Z') {
        cursorX = startX;
        cursorY = startY;
        continue;
      }
    } else if (!command) {
      return null;
    }

    const upper = command.toUpperCase();
    const relative = command !== upper;

    switch (upper) {
      case 'M': {
        const nx = take();
        const ny = take();
        cursorX = relative ? cursorX + nx : nx;
        cursorY = relative ? cursorY + ny : ny;
        startX = cursorX;
        startY = cursorY;
        add(cursorX, cursorY);
        // M 之后的隐式坐标对按 lineto 处理
        command = relative ? 'l' : 'L';
        break;
      }
      case 'L': {
        const nx = take();
        const ny = take();
        cursorX = relative ? cursorX + nx : nx;
        cursorY = relative ? cursorY + ny : ny;
        add(cursorX, cursorY);
        break;
      }
      case 'H': {
        const nx = take();
        cursorX = relative ? cursorX + nx : nx;
        add(cursorX, cursorY);
        break;
      }
      case 'V': {
        const ny = take();
        cursorY = relative ? cursorY + ny : ny;
        add(cursorX, cursorY);
        break;
      }
      case 'C': {
        const x1 = take();
        const y1 = take();
        const x2 = take();
        const y2 = take();
        const x = take();
        const y = take();
        add(relative ? cursorX + x1 : x1, relative ? cursorY + y1 : y1);
        add(relative ? cursorX + x2 : x2, relative ? cursorY + y2 : y2);
        cursorX = relative ? cursorX + x : x;
        cursorY = relative ? cursorY + y : y;
        add(cursorX, cursorY);
        break;
      }
      case 'S': {
        const x2 = take();
        const y2 = take();
        const x = take();
        const y = take();
        add(relative ? cursorX + x2 : x2, relative ? cursorY + y2 : y2);
        cursorX = relative ? cursorX + x : x;
        cursorY = relative ? cursorY + y : y;
        add(cursorX, cursorY);
        break;
      }
      case 'Q': {
        const x1 = take();
        const y1 = take();
        const x = take();
        const y = take();
        add(relative ? cursorX + x1 : x1, relative ? cursorY + y1 : y1);
        cursorX = relative ? cursorX + x : x;
        cursorY = relative ? cursorY + y : y;
        add(cursorX, cursorY);
        break;
      }
      case 'T': {
        const x = take();
        const y = take();
        cursorX = relative ? cursorX + x : x;
        cursorY = relative ? cursorY + y : y;
        add(cursorX, cursorY);
        break;
      }
      case 'A': {
        take();
        take();
        take();
        take();
        take();
        const x = take();
        const y = take();
        cursorX = relative ? cursorX + x : x;
        cursorY = relative ? cursorY + y : y;
        add(cursorX, cursorY);
        break;
      }
      default:
        // 未知命令：放弃包围盒计算，退回声明的 viewBox
        return null;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

/** 汇总 body 内所有图形的包围盒；遇到无法安全处理的节点则返回 null。 */
function computeContentBBox(body: string, declared: [number, number, number, number]): BBox | null {
  // 存在 transform 时坐标已被改写，保守起见不做包围盒推断
  if (/<g\b[^>]*transform\s*=/i.test(body)) return null;
  if (/<(image|use|text)\b/i.test(body)) return null;

  const boxes: BBox[] = [];

  for (const matched of body.matchAll(/<path\b([^>]*)>/gi)) {
    const d = matched[1].match(/\bd\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!d) continue;
    const parsed = pathBBox(d);
    if (parsed) boxes.push(parsed);
  }

  for (const matched of body.matchAll(/<rect\b([^>]*)>/gi)) {
    const x = readAttr(matched[1], 'x') ?? 0;
    const y = readAttr(matched[1], 'y') ?? 0;
    const width = readAttr(matched[1], 'width') ?? 0;
    const height = readAttr(matched[1], 'height') ?? 0;
    if (width > 0 && height > 0) {
      boxes.push({ minX: x, minY: y, maxX: x + width, maxY: y + height });
    }
  }

  for (const matched of body.matchAll(/<circle\b([^>]*)>/gi)) {
    const cx = readAttr(matched[1], 'cx') ?? 0;
    const cy = readAttr(matched[1], 'cy') ?? 0;
    const r = readAttr(matched[1], 'r') ?? 0;
    if (r > 0) boxes.push({ minX: cx - r, minY: cy - r, maxX: cx + r, maxY: cy + r });
  }

  for (const matched of body.matchAll(/<ellipse\b([^>]*)>/gi)) {
    const cx = readAttr(matched[1], 'cx') ?? 0;
    const cy = readAttr(matched[1], 'cy') ?? 0;
    const rx = readAttr(matched[1], 'rx') ?? 0;
    const ry = readAttr(matched[1], 'ry') ?? 0;
    if (rx > 0 && ry > 0) {
      boxes.push({ minX: cx - rx, minY: cy - ry, maxX: cx + rx, maxY: cy + ry });
    }
  }

  if (boxes.length === 0) return null;

  const box = boxes.reduce((acc, item) => ({
    minX: Math.min(acc.minX, item.minX),
    minY: Math.min(acc.minY, item.minY),
    maxX: Math.max(acc.maxX, item.maxX),
    maxY: Math.max(acc.maxY, item.maxY),
  }));

  // 外扩一点，避免描边被裁切
  const width = box.maxX - box.minX;
  const height = box.maxY - box.minY;
  if (!(width > 0) || !(height > 0)) return null;

  const margin = Math.max(width, height) * 0.02;
  const padded: BBox = {
    minX: box.minX - margin,
    minY: box.minY - margin,
    maxX: box.maxX + margin,
    maxY: box.maxY + margin,
  };

  // 合理性校验：必须在声明 viewBox 的 1.5 倍范围内，且不能小到离谱
  const [vx, vy, vw, vh] = declared;
  const tolerance = 0.5 * Math.max(vw, vh);
  const inside =
    padded.minX >= vx - tolerance &&
    padded.minY >= vy - tolerance &&
    padded.maxX <= vx + vw + tolerance &&
    padded.maxY <= vy + vh + tolerance;
  const declaredArea = vw * vh;
  const boxArea = (padded.maxX - padded.minX) * (padded.maxY - padded.minY);
  if (!inside || boxArea > declaredArea * 2 || boxArea < declaredArea * 0.0005) {
    return null;
  }

  return padded;
}

// ---------------------------------------------------------------------------
// 数据抽取
// ---------------------------------------------------------------------------

/** 甲骨文层有两批数据：汉典摹本（char_form 为空）与 JGW 骨架（char_form 有值）。 */
function pickOracleRow(rows: CsvRow[]): CsvRow | null {
  if (rows.length === 0) return null;
  const zdic = rows.filter((row) => !row.char_form);
  return (zdic.length > 0 ? zdic : rows)[0];
}

/** 金文 / 隶书每字有多条（不同器物、不同时代），index.csv 已按时间排序。 */
function pickEarliestRow(rows: CsvRow[]): CsvRow | null {
  return rows.length > 0 ? rows[0] : null;
}

/**
 * 同一书体在同一字下常有多条实例（不同器物 / 碑帖 / 时代）。
 * 为了让演变链的时代顺序更自然（金文取西周、隶书取两汉），
 * 按偏好朝代依次匹配；都不命中则退回最早的一条。
 * 注意：这里只是「挑选展示哪一个真实实例」，不会改动任何字形或年代标注。
 */
function pickPreferredRow(rows: CsvRow[], preferences: string[]): CsvRow | null {
  if (rows.length === 0) return null;
  for (const token of preferences) {
    const hit = rows.find((row) => (row.period ?? '').includes(token));
    if (hit) return hit;
  }
  return rows[0];
}

const PERIOD_PREFERENCE: Record<string, string[]> = {
  bronze: ['西周', '周', '春秋', '戰國', '战国'],
  clerical: ['西漢', '西汉', '漢', '汉', '新莽', '東漢', '东汉'],
};

function shortSource(text: string, max = 46): string {
  const value = text.trim();
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function describeSource(layer: LayerConfig, row: CsvRow): string {
  if (layer.id === 'kaishu') {
    const font = [row.font_name, row.font_version].filter(Boolean).join(' ');
    return font ? `字体轮廓 · ${font}` : '字体轮廓';
  }
  if (layer.id === 'oracle' && row.char_form) {
    return 'Oracle Bone Glyphs 参数化数据集 v0.3（骨架）';
  }
  const detail = shortSource(row.variant || '');
  return detail ? `漢典 zdic.net · ${detail}` : '漢典 zdic.net';
}

/**
 * 下载并归一化一个字形文件，产出单个阶段。
 * 取样（挑哪一行）已在上游 buildLayerIndex 里完成，这里只负责取数。
 */
async function resolveStageFromRow(
  layer: LayerConfig,
  row: CsvRow,
  refresh: boolean,
): Promise<GlyphStage | null> {
  if (!row.file) return null;

  const relPath = `${layer.dir}/${row.file}`;
  const rawSvg = await fetchFromSource(relPath, refresh);
  const svg = normalizeSvg(rawSvg, `${layer.id}-${row.file.replace(/\.svg$/i, '')}`);

  return {
    name: layer.name,
    // 数据源给了更细的朝代就用数据源的，否则退回该书的典型年代
    era: row.period || layer.era,
    svg,
    source: describeSource(layer, row),
  };
}

/**
 * 把某一层的索引按字聚合，并**当场完成取样**（甲骨取汉典摹本、金文取西周…），
 * 这样内存里每层每字只留一行，全量 1.5 万字也不会爆。
 */
function buildLayerIndex(layer: LayerConfig, rows: CsvRow[]): Map<string, CsvRow> {
  const grouped = new Map<string, CsvRow[]>();
  for (const row of rows) {
    const char = row.modern_char;
    // 只收单码位汉字，多字条目（异体合记）跳过
    if (!char || Array.from(char).length !== 1) continue;
    const list = grouped.get(char);
    if (list) list.push(row);
    else grouped.set(char, [row]);
  }

  const selected = new Map<string, CsvRow>();
  for (const [char, list] of grouped) {
    const row =
      layer.id === 'oracle'
        ? pickOracleRow(list)
        : PERIOD_PREFERENCE[layer.id]
          ? pickPreferredRow(list, PERIOD_PREFERENCE[layer.id])
          : pickEarliestRow(list);
    if (row) selected.set(char, row);
  }
  return selected;
}

/** 字形文件名：按码位命名，前端可反算，避免维护额外映射。 */
function glyphFileName(char: string): string {
  const cp = char.codePointAt(0) ?? 0;
  return `${cp.toString(16).toUpperCase().padStart(6, '0')}.json`;
}

interface GlyphManifest {
  meta: GlyphDatasetMeta;
  /** 全局阶段顺序，前端据此画刻度 */
  stageOrder: string[];
  /** 有数据的字（紧凑字符串，前端建 Set 做 O(1) 判断） */
  chars: string;
  /** true = 字形按字分文件；false = 全部内联在 glyphs 字段 */
  split: boolean;
  /** 仅 split=false 时存在 */
  glyphs?: Record<string, GlyphEntry>;
}

/**
 * 抓取真实数据并写盘。
 *
 * 全量模式下按 BATCH_SIZE 分批处理：每批展开成文件任务 → 并发下载 → 组装 → 落盘，
 * 处理完就释放，内存峰值只跟批大小有关，与总字数无关。
 */
async function buildAndWrite(options: {
  refresh: boolean;
  chars: string[] | null;
  charSource: string;
}): Promise<void> {
  const indexTexts = new Map<string, string>();
  for (const layer of LAYERS) {
    const indexPath = `${layer.dir}/index.csv`;
    const text = await fetchFromSource(indexPath, options.refresh);
    indexTexts.set(layer.id, text);
    console.log(`[build-glyphs] 读取索引 ${indexPath}（${text.length} 字符）`);
  }

  // 逐层聚合 + 取样
  const indexes = new Map<string, Map<string, CsvRow>>();
  for (const layer of LAYERS) {
    const rows = parseCsv(indexTexts.get(layer.id) ?? '');
    indexes.set(layer.id, buildLayerIndex(layer, rows));
    console.log(
      `[build-glyphs] ${layer.name}：索引 ${rows.length} 条 → 收字 ${indexes.get(layer.id)?.size ?? 0} 个`,
    );
  }

  // 决定目标字集：--all 时取五层并集
  let targetChars: string[];
  if (options.chars) {
    targetChars = options.chars;
  } else {
    const union = new Set<string>();
    for (const map of indexes.values()) for (const char of map.keys()) union.add(char);
    targetChars = [...union].sort((a, b) => (a.codePointAt(0) ?? 0) - (b.codePointAt(0) ?? 0));
  }

  const useSplit = targetChars.length > INLINE_LIMIT;

  // 统计待下载文件数
  let fileCount = 0;
  for (const char of targetChars) {
    for (const layer of LAYERS) if (indexes.get(layer.id)?.has(char)) fileCount += 1;
  }
  console.log(
    `[build-glyphs] 目标 ${targetChars.length} 字 / ${fileCount} 个字形文件；` +
      `输出模式：${useSplit ? '按字分文件' : '单文件内联'}`,
  );

  if (useSplit) {
    // 清空旧的分字目录，避免上一次的字集残留
    await fs.rm(SPLIT_DIR, { recursive: true, force: true });
    await fs.mkdir(SPLIT_DIR, { recursive: true });
    await fs.rm(OUT_FILE, { force: true });
  }

  const layerOrder = new Map(LAYERS.map((layer, index) => [layer.name, index]));
  const inlineGlyphs: Record<string, GlyphEntry> = {};
  const writtenChars: string[] = [];
  const stageHistogram = new Map<number, number>();
  let totalStages = 0;
  let failed = 0;

  const startedAt = Date.now();

  for (let start = 0; start < targetChars.length; start += BATCH_SIZE) {
    const batch = targetChars.slice(start, start + BATCH_SIZE);

    type Task = { char: string; layer: LayerConfig; row: CsvRow };
    const tasks: Task[] = [];
    for (const char of batch) {
      for (const layer of LAYERS) {
        const row = indexes.get(layer.id)?.get(char);
        if (row) tasks.push({ char, layer, row });
      }
    }

    const results = await mapWithConcurrency(tasks, BULK_CONCURRENCY, async (task) => {
      try {
        const stage = await resolveStageFromRow(task.layer, task.row, options.refresh);
        return { ...task, stage };
      } catch (error) {
        failed += 1;
        console.warn(
          `[build-glyphs] 跳过 ${task.char}/${task.layer.name}：${(error as Error).message}`,
        );
        return { ...task, stage: null };
      }
    });

    // 组装本批的字
    const batchGlyphs = new Map<string, GlyphEntry>();
    for (const item of results) {
      if (!item.stage) continue;
      const entry = batchGlyphs.get(item.char) ?? { char: item.char, stages: [] };
      entry.stages.push(item.stage);
      batchGlyphs.set(item.char, entry);
    }

    for (const [char, entry] of batchGlyphs) {
      entry.stages.sort(
        (a, b) => (layerOrder.get(a.name) ?? 99) - (layerOrder.get(b.name) ?? 99),
      );
      writtenChars.push(char);
      totalStages += entry.stages.length;
      stageHistogram.set(
        entry.stages.length,
        (stageHistogram.get(entry.stages.length) ?? 0) + 1,
      );

      if (useSplit) {
        await fs.writeFile(
          path.join(SPLIT_DIR, glyphFileName(char)),
          JSON.stringify(entry),
          'utf8',
        );
      } else {
        inlineGlyphs[char] = entry;
      }
    }

    // 进度
    const done = Math.min(start + BATCH_SIZE, targetChars.length);
    const elapsed = (Date.now() - startedAt) / 1000;
    const rate = done / elapsed;
    const eta = rate > 0 ? (targetChars.length - done) / rate : 0;
    console.log(
      `[build-glyphs] 进度 ${done}/${targetChars.length} 字` +
        `（${elapsed.toFixed(0)}s，剩余约 ${(eta / 60).toFixed(1)} 分钟）`,
    );
  }

  // 覆盖率汇总
  const hist = [...stageHistogram.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([stages, count]) => `${stages} 阶段 ${count} 字`)
    .join('，');
  console.log(`[build-glyphs] 阶段分布：${hist}`);
  if (failed > 0) console.log(`[build-glyphs] 下载失败 ${failed} 个（可重跑补齐，已有缓存）`);

  // 指定字集时，仍然逐字报告缺口（仅内联模式能拿到完整阶段信息）
  if (options.chars) {
    const writtenSet = new Set(writtenChars);
    const missing: string[] = [];
    for (const char of targetChars) {
      if (!writtenSet.has(char)) {
        missing.push(`${char}：五层全缺`);
        continue;
      }
      if (useSplit) continue;
      const entry = inlineGlyphs[char];
      if (!entry) continue;
      const owned = new Set(entry.stages.map((stage) => stage.name));
      const absent = LAYERS.filter((layer) => !owned.has(layer.name)).map((layer) => layer.name);
      if (absent.length > 0) missing.push(`${char}：缺${absent.join('、')}`);
    }
    if (missing.length > 0) {
      console.log('[build-glyphs] 覆盖缺口：');
      for (const line of missing) console.log(`  · ${line}`);
    } else {
      console.log('[build-glyphs] 全部字五层齐全');
    }
  }

  const meta: GlyphDatasetMeta = {
    mode: 'real',
    source: REPO,
    sourceUrl: REPO_URL,
    license:
      '甲骨文（汉典摹本）、金文、篆书、隶书：CC0-1.0；甲骨文 JGW 骨架：CC BY 4.0；楷书字形取自 Ma Shan Zheng 字体轮廓：OFL-1.1',
    generatedAt: new Date().toISOString(),
    charCount: writtenChars.length,
    stageCount: totalStages,
    note:
      `字集来源：${options.charSource}；${writtenChars.length} 字 / ${totalStages} 个字形阶段；` +
      `抓取镜像：${[...usedMirrors].join(', ') || '本地缓存'}。`,
  };

  const manifest: GlyphManifest = {
    meta,
    stageOrder: LAYERS.map((layer) => layer.name),
    chars: writtenChars.join(''),
    split: useSplit,
  };

  if (useSplit) {
    await fs.writeFile(MANIFEST_FILE, `${JSON.stringify(manifest)}\n`, 'utf8');
    const dirSize = await directorySize(SPLIT_DIR);
    console.log(
      `[build-glyphs] 已写出 ${path.relative(ROOT, MANIFEST_FILE)} + ` +
        `${writtenChars.length} 个分字文件（合计 ${(dirSize / 1024 / 1024).toFixed(1)} MB）`,
    );
  } else {
    manifest.glyphs = inlineGlyphs;
    await fs.writeFile(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    const size = (await fs.stat(OUT_FILE)).size;
    await fs.rm(MANIFEST_FILE, { force: true });
    await fs.rm(SPLIT_DIR, { recursive: true, force: true });
    console.log(
      `[build-glyphs] 已写出 ${path.relative(ROOT, OUT_FILE)}：` +
        `${writtenChars.length} 字 / ${totalStages} 阶段 / ${(size / 1024).toFixed(1)} KB`,
    );
  }

  console.log(`[build-glyphs] 数据模式：real`);
}

/** 递归统计目录体积。 */
async function directorySize(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) total += await directorySize(full);
    else total += (await fs.stat(full)).size;
  }
  return total;
}

// ---------------------------------------------------------------------------
// 降级数据：内置占位图形
// ---------------------------------------------------------------------------

const FALLBACK_STAGES = [
  { name: '甲骨文', era: '商' },
  { name: '金文', era: '周' },
  { name: '小篆', era: '秦' },
  { name: '隶书', era: '汉' },
  { name: '楷书', era: '今' },
];

/**
 * 生成一个**明确的人造占位图形**（虚线外框 + 与阶段序号等量的横杠）。
 * 刻意不模仿任何真实古文字形，避免以 AI/臆造字形冒充真实字形数据。
 */
function placeholderSvg(stageIndex: number, stageCount: number): string {
  const bars = Math.min(stageIndex + 1, stageCount);
  const gap = 14;
  const startY = CANVAS / 2 - ((bars - 1) * gap) / 2;

  const rects = Array.from({ length: bars }, (_, i) => {
    const width = 40 - i * 3;
    return `<rect x="${round(CANVAS / 2 - width / 2, 2)}" y="${round(startY + i * gap - 3, 2)}" width="${width}" height="6" rx="3"/>`;
  }).join('');

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS} ${CANVAS}" fill="currentColor" ` +
    `data-placeholder="true" aria-hidden="true">` +
    `<rect x="8" y="8" width="84" height="84" rx="12" fill="none" stroke="currentColor" ` +
    `stroke-width="1.5" stroke-dasharray="5 5" opacity="0.4"/>` +
    rects +
    `</svg>`
  );
}

function buildFallbackManifest(note: string, chars: string[]): GlyphManifest {
  const glyphs: Record<string, GlyphEntry> = {};

  for (const char of chars) {
    glyphs[char] = {
      char,
      stages: FALLBACK_STAGES.map((stage, index) => ({
        name: stage.name,
        era: stage.era,
        svg: placeholderSvg(index, FALLBACK_STAGES.length),
        source: '内置示例占位图形（非真实字形）',
        placeholder: true,
      })),
    };
  }

  return {
    meta: {
      mode: 'fallback',
      source: REPO,
      sourceUrl: REPO_URL,
      license: '占位图形由本项目生成，不含任何第三方字形数据。',
      generatedAt: new Date().toISOString(),
      charCount: chars.length,
      stageCount: chars.length * FALLBACK_STAGES.length,
      note,
    },
    stageOrder: FALLBACK_STAGES.map((stage) => stage.name),
    chars: chars.join(''),
    split: false,
    glyphs,
  };
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

/** 写「内联」形态的数据（小字集 / 降级数据）。分字形态由 buildAndWrite 直接落盘。 */
async function writeInlineManifest(manifest: GlyphManifest): Promise<void> {
  await fs.mkdir(PUBLIC_DATA_DIR, { recursive: true });
  await fs.writeFile(OUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  // 清掉另一种形态的产物，避免前端读到过期数据
  await fs.rm(MANIFEST_FILE, { force: true });
  await fs.rm(SPLIT_DIR, { recursive: true, force: true });

  const size = (await fs.stat(OUT_FILE)).size;
  console.log(
    `[build-glyphs] 已写出 ${path.relative(ROOT, OUT_FILE)}：` +
      `${manifest.meta.charCount} 字 / ${manifest.meta.stageCount} 阶段 / ${(size / 1024).toFixed(1)} KB`,
  );
  console.log(`[build-glyphs] 数据模式：${manifest.meta.mode}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const args = new Set(argv);
  const offline = args.has('--offline');
  const refresh = args.has('--refresh');

  // --local=<仓库根目录>：从本地克隆读取，绕开网络瓶颈
  const localArg = argv.find((arg) => arg.startsWith('--local='));
  if (localArg) {
    const localPath = path.resolve(localArg.slice('--local='.length));
    try {
      await fs.access(path.join(localPath, 'glyphs'));
    } catch {
      console.error(`[build-glyphs] --local 指向的目录不存在或不是仓库根目录：${localPath}`);
      process.exitCode = 1;
      return;
    }
    LOCAL_ROOT = localPath;
    console.log(`[build-glyphs] 本地仓库模式：${localPath}`);
  }

  const { chars, source: charSource } = resolveTargetChars(argv);

  if (offline) {
    // 全量占位没有意义（1.5 万字 × 5 个占位图形），离线一律回落到默认字集
    const offlineChars = chars ?? DEFAULT_CHARS;
    console.log(
      `[build-glyphs] --offline：跳过网络，生成 ${offlineChars.length} 字的内置占位数据` +
        (chars ? '' : '（--all 在离线模式下回落到默认字集）'),
    );
    await writeInlineManifest(
      buildFallbackManifest(
        '离线模式（--offline）：未访问网络，当前为内置示例占位数据。',
        offlineChars,
      ),
    );
    return;
  }

  console.log(
    `[build-glyphs] 字集来源：${charSource}` +
      (chars ? `，共 ${chars.length} 字：${chars.join('')}` : ''),
  );

  try {
    await buildAndWrite({ refresh, chars, charSource });
  } catch (error) {
    const message = (error as Error).message;
    console.warn(`[build-glyphs] 真实数据构建失败：${message}`);
    console.warn('[build-glyphs] 降级为内置占位数据（会在 UI 与 README 中标注）。');
    await writeInlineManifest(
      buildFallbackManifest(
        `数据源不可用（${message}），已降级为内置示例占位数据。`,
        chars ?? DEFAULT_CHARS,
      ),
    );
  }
}

main().catch((error: unknown) => {
  console.error('[build-glyphs] 未捕获错误：', error);
  process.exitCode = 1;
});
