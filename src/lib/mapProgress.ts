/**
 * 全局时间轴进度（0–100）到「单字阶段索引」的映射。
 *
 * 这里的所有函数都是纯函数：给定相同输入永远返回相同输出，不读写任何外部状态，
 * 因此可以脱离 React 单独测试（见 tests/mapProgress.test.ts）。
 */
import type { GlyphEntry } from './types';

/** 时间轴进度下界。 */
export const MIN_PROGRESS = 0;
/** 时间轴进度上界。 */
export const MAX_PROGRESS = 100;

/**
 * 把任意数字收敛到 [0, 100]。
 * 非有限数（NaN / Infinity）一律视为 0，避免把脏数据传到下游。
 */
export function clampProgress(progress: number): number {
  if (!Number.isFinite(progress)) return MIN_PROGRESS;
  if (progress < MIN_PROGRESS) return MIN_PROGRESS;
  if (progress > MAX_PROGRESS) return MAX_PROGRESS;
  return progress;
}

/**
 * 核心映射：全局进度 → 该字自己的阶段索引。
 *
 * 规则：
 * - stageCount <= 0（无字形数据）→ -1；
 * - 进度按 [0,100] 等分成 stageCount 段，落在第几段就是第几个阶段；
 * - progress = 0 → 0，progress = 100 → stageCount - 1（两端闭合）。
 *
 * 不同字的阶段数不同也能正确工作：各字用自己的 stageCount 独立分段，
 * 所以阶段少的字会「走得更慢」，阶段多的字会「换得更勤」，但都从首阶段走到末阶段。
 *
 * @example
 * getStageIndex(0, 5)    // 0  → 甲骨文
 * getStageIndex(50, 5)   // 2  → 小篆
 * getStageIndex(100, 5)  // 4  → 楷书
 * getStageIndex(100, 3)  // 2  → 末阶段
 * getStageIndex(50, 0)   // -1 → 无数据
 */
export function getStageIndex(globalProgress: number, stageCount: number): number {
  // 阶段数非法（无数据 / 负数 / 非整数）时返回 -1，交给 UI 显示占位
  if (!Number.isFinite(stageCount) || stageCount < 1) return -1;

  const count = Math.floor(stageCount);
  if (count < 1) return -1;

  const progress = clampProgress(globalProgress);
  const raw = Math.floor((progress / MAX_PROGRESS) * count);

  // 边界收敛：progress=100 时 raw 会等于 count，必须落回最后一个阶段
  if (raw < 0) return 0;
  if (raw > count - 1) return count - 1;
  return raw;
}

/**
 * 反向映射：某个阶段在全局时间轴上占据的起点百分比。
 * 用于点击刻度标签时跳转到该阶段的起点。
 */
export function getStageStartProgress(stageIndex: number, stageCount: number): number {
  if (!Number.isFinite(stageCount) || stageCount < 1) return MIN_PROGRESS;
  const count = Math.floor(stageCount);
  const index = Math.min(Math.max(Math.floor(stageIndex), 0), count - 1);
  return (index / count) * MAX_PROGRESS;
}

/**
 * 反向映射：某个阶段占据的进度区间 [start, end)，末阶段 end 为 100。
 * 用于绘制刻度条。
 */
export function getStageProgressRange(
  stageIndex: number,
  stageCount: number,
): { start: number; end: number } {
  if (!Number.isFinite(stageCount) || stageCount < 1) {
    return { start: MIN_PROGRESS, end: MAX_PROGRESS };
  }
  const count = Math.floor(stageCount);
  const index = Math.min(Math.max(Math.floor(stageIndex), 0), count - 1);
  return {
    start: (index / count) * MAX_PROGRESS,
    end: ((index + 1) / count) * MAX_PROGRESS,
  };
}

/**
 * 从数据集里推导出「全局阶段顺序」。
 *
 * 各字的阶段数量可能不同（例如缺金文的字只有 4 段），所以不能直接取某一个字的
 * stages。这里统计每个阶段名在各自字中出现的平均位置，按平均位置升序排列，
 * 位置相同则按首次出现顺序稳定排序。
 *
 * 结果用于时间轴上方的「甲骨文 → 金文 → 小篆 → 隶书 → 楷书」刻度。
 */
export function deriveStageSequence(entries: GlyphEntry[]): string[] {
  const acc = new Map<string, { sum: number; count: number; firstSeen: number }>();

  for (const entry of entries) {
    entry.stages.forEach((stage, index) => {
      const current = acc.get(stage.name);
      if (current) {
        current.sum += index;
        current.count += 1;
      } else {
        acc.set(stage.name, { sum: index, count: 1, firstSeen: acc.size });
      }
    });
  }

  return [...acc.entries()]
    .sort((a, b) => {
      const avgA = a[1].sum / a[1].count;
      const avgB = b[1].sum / b[1].count;
      if (avgA !== avgB) return avgA - avgB;
      return a[1].firstSeen - b[1].firstSeen;
    })
    .map(([name]) => name);
}
