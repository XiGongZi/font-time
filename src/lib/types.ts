/**
 * 全局数据类型定义。
 *
 * 数据结构与需求约定一致：一个字对应若干「阶段」，每个阶段一份 SVG 字形。
 * 阶段名称与年代一律来自数据源，不做臆造。
 */

/** 单个字形阶段，例如「甲骨文 / 商」。 */
export interface GlyphStage {
  /** 阶段（书体）名称，如「甲骨文」「金文」「小篆」「隶书」「楷书」。 */
  name: string;
  /** 年代标签，如「商」「周」「秦」「汉」「今」；数据源有更细的朝代则用数据源的值。 */
  era: string;
  /** 归一化到 0 0 100 100 viewBox 的 SVG 字符串，颜色使用 currentColor。 */
  svg: string;
  /** 出处简述，例如「漢典 zdic.net · 日鐵13.3 合13312 賓組」。 */
  source?: string;
  /** 是否为占位图形（非真实字形）。true 时 UI 会显式标注，绝不冒充真实古文字。 */
  placeholder?: boolean;
}

/** 一个汉字及其全部阶段字形。 */
export interface GlyphEntry {
  char: string;
  stages: GlyphStage[];
}

/** 数据集元信息，用于在 UI 与 README 中说明数据来源与降级情况。 */
export interface GlyphDatasetMeta {
  /** real = 来自真实开源字形库；fallback = 内置示例占位数据。 */
  mode: 'real' | 'fallback';
  /** 数据源名称。 */
  source: string;
  /** 数据源地址。 */
  sourceUrl: string;
  /** 授权说明。 */
  license: string;
  /** 生成时间（ISO 字符串）。 */
  generatedAt: string;
  /** 收录字数。 */
  charCount: number;
  /** 字形阶段总数。 */
  stageCount: number;
  /** 附加说明（降级原因、抓取镜像等）。 */
  note?: string;
}

/**
 * 数据清单。
 *
 * 两种形态：
 * - `split === false`：字形全部内联在 `glyphs` 里（小字集，一次请求拿完）；
 * - `split === true`：`glyphs` 不存在，字形按字拆到 `data/glyphs/<码位>.json`，
 *   前端按需加载（全量 1.5 万字时用这种，避免一次下载几十 MB）。
 */
export interface GlyphManifest {
  meta: GlyphDatasetMeta;
  /** 全局阶段顺序，用于绘制时间轴刻度 */
  stageOrder: string[];
  /** 有字形数据的字（紧凑字符串），前端建 Set 做 O(1) 判断 */
  chars: string;
  /** true = 按字分文件 */
  split: boolean;
  /** 仅 split === false 时存在 */
  glyphs?: Record<string, GlyphEntry>;
  /** 运行时标记：清单来自 /api（node 后端按需分发），而非静态文件 */
  api?: boolean;
}
