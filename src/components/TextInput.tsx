import { useId } from 'react';

interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  /** 汉字数量（用于提示） */
  hanCount: number;
  /** 超过上限被截断时给出提示 */
  truncated: boolean;
}

const PRESETS = [
  '日月山水',
  '日月山水人木火土',
  '日月山水人木火土口手目耳心大小上下中田雨',
  '日月山水你我他',
];

export default function TextInput({ value, onChange, hanCount, truncated }: TextInputProps) {
  const inputId = useId();

  return (
    <section className="panel input-panel" aria-labelledby={`${inputId}-label`}>
      <div className="panel-head">
        <label id={`${inputId}-label`} className="panel-title" htmlFor={inputId}>
          输入文本
        </label>
        <span className="panel-hint">
          共 {hanCount} 个汉字
          {truncated && '（超出上限，已截断）'}
        </span>
      </div>

      <textarea
        id={inputId}
        className="text-input"
        value={value}
        rows={2}
        spellCheck={false}
        placeholder="例如：日月山水"
        onChange={(event) => onChange(event.target.value)}
      />

      <div className="preset-row">
        <span className="preset-label">试试：</span>
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className="chip"
            onClick={() => onChange(preset)}
            title={preset}
          >
            {preset.length > 8 ? `${preset.slice(0, 8)}…` : preset}
          </button>
        ))}
        <button type="button" className="chip chip--ghost" onClick={() => onChange('')}>
          清空
        </button>
      </div>
    </section>
  );
}
