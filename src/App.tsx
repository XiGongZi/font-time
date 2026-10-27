import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import GlyphCard from './components/GlyphCard';
import GlyphZoom from './components/GlyphZoom';
import TextInput from './components/TextInput';
import Timeline from './components/Timeline';
import { loadGlyphsBatch, loadManifest } from './lib/loadGlyphs';
import { deriveStageSequence, getStageIndex } from './lib/mapProgress';
import { countHanChars, splitText } from './lib/splitText';
import type { GlyphEntry, GlyphManifest } from './lib/types';

const DEFAULT_TEXT = '日月山水';
/** 单次最多渲染的字数，避免超长文本把页面拖垮。 */
const MAX_TOKENS = 120;
/** 默认播放速度：每秒推进 12 个进度点，约 8.3 秒走完全程。 */
const DEFAULT_SPEED = 12;

export default function App() {
  const [text, setText] = useState(DEFAULT_TEXT);
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(DEFAULT_SPEED);
  const [manifest, setManifest] = useState<GlyphManifest | null>(null);
  /** 已加载的字形；null 表示「查过了，确实没有」 */
  const [glyphs, setGlyphs] = useState<Record<string, GlyphEntry | null>>({});
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<{ entry: GlyphEntry; stageIndex: number } | null>(null);

  // 播放循环读取的最新进度，避免在 rAF 回调里依赖 React 的异步 state
  const progressRef = useRef(0);
  // 正在请求中的字，防止同一批字被重复发起请求
  const pendingRef = useRef(new Set<string>());

  // —— 加载数据清单 ——
  useEffect(() => {
    let alive = true;
    loadManifest()
      .then((data) => {
        if (alive) setManifest(data);
      })
      .catch((error: Error) => {
        if (alive) setLoadError(error.message);
      });
    return () => {
      alive = false;
    };
  }, []);

  // —— 文本拆分 ——
  const allTokens = useMemo(() => splitText(text), [text]);
  const tokens = useMemo(() => allTokens.slice(0, MAX_TOKENS), [allTokens]);
  const hanCount = useMemo(() => countHanChars(tokens), [tokens]);
  const truncated = allTokens.length > MAX_TOKENS;

  /** 当前文本里去重后的汉字，用于按需加载 */
  const uniqueChars = useMemo(
    () => [...new Set(tokens.filter((token) => token.isHan).map((token) => token.char))],
    [tokens],
  );

  // —— 按需加载：只取当前文本用到的字 ——
  useEffect(() => {
    if (!manifest) return;

    const todo = uniqueChars.filter(
      (char) => !(char in glyphs) && !pendingRef.current.has(char),
    );
    if (todo.length === 0) return;

    for (const char of todo) pendingRef.current.add(char);
    let alive = true;
    setLoading(true);

    loadGlyphsBatch(manifest, todo)
      .then((loaded) => {
        if (!alive) return;
        setGlyphs((prev) => {
          const next = { ...prev };
          for (const [char, entry] of loaded) next[char] = entry;
          return next;
        });
      })
      .finally(() => {
        for (const char of todo) pendingRef.current.delete(char);
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, [manifest, uniqueChars, glyphs]);

  // —— 全局阶段顺序：优先用构建期写入的 stageOrder ——
  const stageNames = useMemo(() => {
    if (!manifest) return [];
    if (manifest.stageOrder.length > 0) return manifest.stageOrder;
    // 兜底：清单里没有顺序时，从内联数据推导
    const inline = manifest.glyphs ? Object.values(manifest.glyphs) : [];
    return deriveStageSequence(inline);
  }, [manifest]);

  const activeStageIndex = getStageIndex(progress, stageNames.length);

  /**
   * 阶段数少于全局阶段数的字。
   * 它们的每个阶段占更长的进度区间（2 阶段的字每段 50%），拖动时会「换得更慢」，
   * 提前说明一句，免得用户以为卡片卡住了。
   */
  const partialChars = useMemo(() => {
    const full = stageNames.length;
    if (full === 0) return [];
    return uniqueChars.filter((char) => {
      const entry = glyphs[char];
      return entry && entry.stages.length < full;
    });
  }, [uniqueChars, glyphs, stageNames]);

  // —— 播放：requestAnimationFrame 推进进度 ——
  useEffect(() => {
    if (!playing) return;

    let raf = 0;
    let last = performance.now();

    const step = (now: number) => {
      // 单帧最大步长做上限，切后台再回来时不会一下跳到终点
      const delta = Math.min(now - last, 200);
      last = now;

      const next = Math.min(100, progressRef.current + (delta / 1000) * speed);
      progressRef.current = next;
      setProgress(next);

      if (next >= 100) {
        setPlaying(false);
        return;
      }
      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  const handleProgressChange = useCallback((value: number) => {
    progressRef.current = value;
    setProgress(value);
  }, []);

  const handleTogglePlay = useCallback(() => {
    setPlaying((prev) => {
      if (prev) return false;
      // 已在终点时，再次播放从头开始
      if (progressRef.current >= 100) {
        progressRef.current = 0;
        setProgress(0);
      }
      return true;
    });
  }, []);

  const handleReset = useCallback(() => {
    setPlaying(false);
    progressRef.current = 0;
    setProgress(0);
  }, []);

  const handleZoom = useCallback((entry: GlyphEntry, stageIndex: number) => {
    setZoom({ entry, stageIndex });
  }, []);

  const closeZoom = useCallback(() => setZoom(null), []);

  const isFallback = manifest?.meta.mode === 'fallback';

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <h1 className="brand-title">汉字时光机</h1>
          <p className="brand-sub">
            输入文字，拖动时间轴，看同一个字在甲骨文、金文、小篆、隶书、楷书里怎么一步步变成今天的样子。
          </p>
        </div>
        <div className="header-badges">
          {manifest && (
            <>
              <span className={`badge ${isFallback ? 'badge--warn' : 'badge--ok'}`}>
                {isFallback ? '示例占位数据' : '真实字形数据'}
              </span>
              <span className="badge badge--count">
                {manifest.meta.charCount.toLocaleString('zh-CN')} 字
              </span>
            </>
          )}
          <a
            className="badge badge--link"
            href={manifest?.meta.sourceUrl ?? 'https://github.com/zhouyongh/hanzi-glyphs-svg'}
            target="_blank"
            rel="noreferrer"
          >
            {manifest?.meta.source ?? 'hanzi-glyphs-svg'}
          </a>
        </div>
      </header>

      <main className="app-main">
        <TextInput
          value={text}
          onChange={setText}
          hanCount={hanCount}
          truncated={truncated}
        />

        {loadError && (
          <div className="alert alert--error">
            字形数据加载失败：{loadError}
            <br />
            请确认 <code>public/data/manifest.json</code> 或{' '}
            <code>public/data/glyphs.json</code> 存在（可执行{' '}
            <code>npm run data:build</code> 重新生成）。
          </div>
        )}

        {isFallback && manifest && (
          <div className="alert alert--warn">
            {manifest.meta.note ?? '当前使用内置示例占位数据。'}
          </div>
        )}

        {!manifest && !loadError && <div className="alert alert--info">正在加载字形数据…</div>}

        <section className="grid" aria-live="polite">
          {tokens.length === 0 ? (
            <p className="empty-hint">在上方输入几个汉字，这里会显示它们的古今字形。</p>
          ) : (
            tokens.map((token) => {
              const entry = token.isHan ? glyphs[token.char] : undefined;
              const stageIndex = entry ? getStageIndex(progress, entry.stages.length) : -1;
              const isLoading = token.isHan && !(token.char in glyphs) && pendingRef.current.has(token.char);
              return (
                <GlyphCard
                  key={token.key}
                  token={token}
                  entry={entry ?? undefined}
                  stageIndex={stageIndex}
                  loading={isLoading}
                  onZoom={entry ? handleZoom : undefined}
                />
              );
            })
          )}
        </section>

        {loading && tokens.length > 0 && (
          <p className="loading-hint" aria-live="polite">
            正在加载字形…
          </p>
        )}

        {!loading && partialChars.length > 0 && (
          <p className="partial-hint">
            其中{' '}
            <strong>
              {partialChars
                .slice(0, 8)
                .map((char) => `${char}（${glyphs[char]?.stages.length} 阶段）`)
                .join('、')}
              {partialChars.length > 8 ? ` 等 ${partialChars.length} 个字` : ''}
            </strong>{' '}
            阶段不全，每个阶段停留的进度更长，切换节奏会比别的字慢。
          </p>
        )}
      </main>

      <Timeline
        progress={progress}
        onProgressChange={handleProgressChange}
        playing={playing}
        onTogglePlay={handleTogglePlay}
        onReset={handleReset}
        stageNames={stageNames}
        activeStageIndex={activeStageIndex}
        speed={speed}
        onSpeedChange={setSpeed}
        disabled={!manifest || stageNames.length === 0}
      />

      {zoom && (
        <GlyphZoom entry={zoom.entry} stageIndex={zoom.stageIndex} onClose={closeZoom} />
      )}
    </div>
  );
}
