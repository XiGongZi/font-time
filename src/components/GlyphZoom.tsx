import { useEffect } from 'react';
import type { GlyphEntry } from '../lib/types';

interface GlyphZoomProps {
  entry: GlyphEntry;
  stageIndex: number;
  onClose: () => void;
}

/** 单字放大查看（加分项）。点击遮罩或按 Esc 关闭。 */
export default function GlyphZoom({ entry, stageIndex, onClose }: GlyphZoomProps) {
  const stage = entry.stages[stageIndex];

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  if (!stage) return null;

  return (
    <div className="zoom-backdrop" onClick={onClose} role="presentation">
      <div
        className="zoom-card"
        role="dialog"
        aria-modal="true"
        aria-label={`${entry.char} 的${stage.name}`}
        onClick={(event) => event.stopPropagation()}
      >
        <button type="button" className="zoom-close" onClick={onClose} aria-label="关闭">
          ✕
        </button>

        <div
          className="zoom-glyph"
          dangerouslySetInnerHTML={{ __html: stage.svg }}
        />

        <div className="zoom-meta">
          <span className="zoom-char">{entry.char}</span>
          <span className="zoom-stage">
            {stage.name} · {stage.era}
          </span>
        </div>
        {stage.source && <p className="zoom-source">出处：{stage.source}</p>}
        {stage.placeholder && <p className="zoom-source">这是占位图形，不是真实古文字形。</p>}

        <div className="zoom-stages">
          {entry.stages.map((item, index) => (
            <span
              key={item.name}
              className={`zoom-stage-pill${index === stageIndex ? ' is-active' : ''}`}
            >
              {item.name}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
