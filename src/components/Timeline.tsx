import { getStageProgressRange } from '../lib/mapProgress';

interface TimelineProps {
  progress: number;
  onProgressChange: (value: number) => void;
  playing: boolean;
  onTogglePlay: () => void;
  onReset: () => void;
  /** 全局阶段顺序（由数据推导），用于绘制刻度 */
  stageNames: string[];
  /** 当前全局阶段索引，-1 表示无阶段 */
  activeStageIndex: number;
  /** 播放速度（每秒推进的进度百分比） */
  speed: number;
  onSpeedChange: (speed: number) => void;
  disabled: boolean;
}

const SPEED_OPTIONS = [
  { label: '慢', value: 6 },
  { label: '中', value: 12 },
  { label: '快', value: 24 },
];

export default function Timeline({
  progress,
  onProgressChange,
  playing,
  onTogglePlay,
  onReset,
  stageNames,
  activeStageIndex,
  speed,
  onSpeedChange,
  disabled,
}: TimelineProps) {
  const stageCount = stageNames.length;

  return (
    <section className="timeline" aria-label="时间轴">
      <div className="timeline-head">
        <div className="timeline-title">
          <span className="timeline-label">时间轴</span>
          <span className="timeline-value">{Math.round(progress)}</span>
          <span className="timeline-current">
            {activeStageIndex >= 0 ? stageNames[activeStageIndex] : '—'}
          </span>
        </div>

        <div className="timeline-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={onTogglePlay}
            disabled={disabled}
          >
            {playing ? '⏸ 暂停' : '▶ 播放'}
          </button>
          <button type="button" className="btn" onClick={onReset} disabled={disabled}>
            ↺ 重置
          </button>
          <div className="speed-group" role="group" aria-label="播放速度">
            {SPEED_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`speed-btn${speed === option.value ? ' is-active' : ''}`}
                onClick={() => onSpeedChange(option.value)}
                aria-pressed={speed === option.value}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="slider-wrap">
        <input
          className="slider"
          type="range"
          min={0}
          max={100}
          step={0.5}
          value={progress}
          onChange={(event) => onProgressChange(Number(event.target.value))}
          aria-label="全局时间进度"
          disabled={disabled}
        />
        {/* 进度填充条：range 的原生填充在各浏览器表现不一致，这里自绘一层 */}
        <div className="slider-fill" style={{ width: `${progress}%` }} aria-hidden="true" />
      </div>

      <div className="ticks">
        {stageNames.map((name, index) => {
          const range = getStageProgressRange(index, stageCount);
          const width = range.end - range.start;
          const isActive = index === activeStageIndex;
          return (
            <button
              key={name}
              type="button"
              className={`tick${isActive ? ' is-active' : ''}`}
              style={{ left: `${range.start}%`, width: `${width}%` }}
              onClick={() => onProgressChange(range.start)}
              disabled={disabled}
              aria-current={isActive ? 'step' : undefined}
            >
              {name}
            </button>
          );
        })}
      </div>
    </section>
  );
}
