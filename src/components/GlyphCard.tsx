import type { TextToken } from '../lib/splitText';
import type { GlyphEntry } from '../lib/types';

interface GlyphCardProps {
  token: TextToken;
  /** 该字的字形数据；undefined 表示数据集里没有这个字。 */
  entry?: GlyphEntry;
  /** 当前阶段索引；-1 表示无数据。 */
  stageIndex: number;
  /** 该字正在加载中（避免闪现「暂无字形数据」） */
  loading?: boolean;
  /** 点击放大（仅在字形数据存在时可用）。 */
  onZoom?: (entry: GlyphEntry, stageIndex: number) => void;
}

/**
 * 单字卡片。
 *
 * 四种形态：
 * 1. 标点/空格 → 灰色占位格，不参与字形切换；
 * 2. 加载中 → 骨架格；
 * 3. 无字形数据 → 直接显示汉字本身，并提示「暂无字形数据」；
 * 4. 有数据 → 显示当前阶段的 SVG、阶段名、年代。
 */
export default function GlyphCard({
  token,
  entry,
  stageIndex,
  loading = false,
  onZoom,
}: GlyphCardProps) {
  // —— 形态 1：非汉字占位 ——
  if (!token.isHan) {
    return (
      <div className="glyph-card glyph-card--separator" aria-hidden={token.isSpace}>
        <span className="separator-char">{token.isSpace ? '\u00A0' : token.char}</span>
      </div>
    );
  }

  const stage = entry && stageIndex >= 0 ? entry.stages[stageIndex] : undefined;

  // —— 形态 2：加载中 ——
  if (loading && !stage) {
    return (
      <div className="glyph-card glyph-card--loading" aria-busy="true">
        <div className="glyph-frame">
          <span className="loading-spinner" />
        </div>
        <div className="card-meta">
          <span className="card-char">{token.char}</span>
          <span className="card-stage card-stage--muted">加载中…</span>
        </div>
      </div>
    );
  }

  // —— 形态 3：无数据 ——
  if (!entry || !stage) {
    return (
      <div className="glyph-card glyph-card--empty">
        <div className="glyph-frame">
          <span className="empty-char">{token.char}</span>
        </div>
        <div className="card-meta">
          <span className="card-char">{token.char}</span>
          <span className="card-stage card-stage--muted">暂无字形数据</span>
        </div>
      </div>
    );
  }

  // —— 形态 3：正常渲染 ——
  const clickable = Boolean(onZoom);

  return (
    <div className={`glyph-card${clickable ? ' glyph-card--clickable' : ''}`}>
      <button
        type="button"
        className="glyph-frame glyph-frame--button"
        onClick={() => onZoom?.(entry, stageIndex)}
        disabled={!clickable}
        aria-label={`放大查看「${token.char}」的${stage.name}`}
        title={stage.source ? `出处：${stage.source}` : undefined}
      >
        {/* SVG 由构建脚本生成，内容可信；key 变化时重播淡入动画 */}
        <span
          className="glyph-svg"
          key={`${token.char}-${stage.name}`}
          dangerouslySetInnerHTML={{ __html: stage.svg }}
        />
        {stage.placeholder && <span className="badge badge--placeholder">占位</span>}
      </button>

      <div className="card-meta">
        <span className="card-char">{token.char}</span>
        <span className="card-stage">
          <span className="card-stage-name">{stage.name}</span>
          {/* 数据源的 period 可能很长（如「商代晚期或西周早期」），单独包一层以便省略 */}
          <span className="card-era" title={stage.era}>
            {stage.era}
          </span>
        </span>
      </div>
    </div>
  );
}
