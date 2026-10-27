import { describe, expect, it } from 'vitest';
import {
  clampProgress,
  deriveStageSequence,
  getStageIndex,
  getStageProgressRange,
  getStageStartProgress,
} from '../src/lib/mapProgress';
import type { GlyphEntry } from '../src/lib/types';

describe('getStageIndex —— 全局进度到单字阶段索引', () => {
  it('stageCount = 0 时返回 -1（无字形数据）', () => {
    expect(getStageIndex(0, 0)).toBe(-1);
    expect(getStageIndex(50, 0)).toBe(-1);
    expect(getStageIndex(100, 0)).toBe(-1);
  });

  it('stageCount 为负数或非有限数时返回 -1', () => {
    expect(getStageIndex(50, -3)).toBe(-1);
    expect(getStageIndex(50, Number.NaN)).toBe(-1);
    expect(getStageIndex(50, Number.POSITIVE_INFINITY)).toBe(-1);
  });

  it('进度 0 映射到首阶段', () => {
    expect(getStageIndex(0, 5)).toBe(0);
    expect(getStageIndex(0, 1)).toBe(0);
    expect(getStageIndex(0, 12)).toBe(0);
  });

  it('进度 100 映射到末阶段（stageCount - 1）', () => {
    expect(getStageIndex(100, 5)).toBe(4);
    expect(getStageIndex(100, 3)).toBe(2);
    expect(getStageIndex(100, 1)).toBe(0);
    expect(getStageIndex(100, 7)).toBe(6);
  });

  it('5 个阶段时按 20% 一段均匀切分', () => {
    expect(getStageIndex(0, 5)).toBe(0);
    expect(getStageIndex(19.9, 5)).toBe(0);
    expect(getStageIndex(20, 5)).toBe(1);
    expect(getStageIndex(39.9, 5)).toBe(1);
    expect(getStageIndex(40, 5)).toBe(2);
    expect(getStageIndex(50, 5)).toBe(2);
    expect(getStageIndex(60, 5)).toBe(3);
    expect(getStageIndex(79.9, 5)).toBe(3);
    expect(getStageIndex(80, 5)).toBe(4);
    expect(getStageIndex(99.9, 5)).toBe(4);
    expect(getStageIndex(100, 5)).toBe(4);
  });

  it('不同字阶段数不同时，各自独立映射', () => {
    // 同一个进度 60，阶段多的字换得更靠前
    expect(getStageIndex(60, 5)).toBe(3);
    expect(getStageIndex(60, 4)).toBe(2);
    expect(getStageIndex(60, 2)).toBe(1);
    expect(getStageIndex(60, 1)).toBe(0);

    // 阶段少的字会「走得更慢」：60 仍在第 2 段
    expect(getStageIndex(34, 3)).toBe(1);
    expect(getStageIndex(34, 5)).toBe(1);
    expect(getStageIndex(70, 3)).toBe(2);
    expect(getStageIndex(70, 5)).toBe(3);
  });

  it('返回值始终落在 [0, stageCount - 1] 内（含越界进度）', () => {
    for (const count of [1, 2, 3, 4, 5, 8, 13]) {
      for (let progress = -50; progress <= 150; progress += 0.5) {
        const index = getStageIndex(progress, count);
        expect(index).toBeGreaterThanOrEqual(0);
        expect(index).toBeLessThanOrEqual(count - 1);
      }
    }
  });

  it('越界进度会被收敛到边界', () => {
    expect(getStageIndex(-100, 5)).toBe(0);
    expect(getStageIndex(1000, 5)).toBe(4);
  });

  it('非有限进度按 0 处理', () => {
    expect(getStageIndex(Number.NaN, 5)).toBe(0);
    // Infinity 也属于非有限数，统一收敛到 0，避免出现「无穷进度」这类无意义状态
    expect(getStageIndex(Number.POSITIVE_INFINITY, 5)).toBe(0);
    expect(getStageIndex(Number.NEGATIVE_INFINITY, 5)).toBe(0);
  });

  it('是纯函数：同样输入多次调用结果一致，且不修改入参', () => {
    const progress = 37.5;
    const count = 5;
    expect(getStageIndex(progress, count)).toBe(getStageIndex(progress, count));
    expect(progress).toBe(37.5);
    expect(count).toBe(5);
  });
});

describe('clampProgress', () => {
  it('收敛到 [0, 100]', () => {
    expect(clampProgress(-10)).toBe(0);
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(42.5)).toBe(42.5);
    expect(clampProgress(100)).toBe(100);
    expect(clampProgress(120)).toBe(100);
  });

  it('非有限数视为 0', () => {
    expect(clampProgress(Number.NaN)).toBe(0);
  });
});

describe('getStageStartProgress / getStageProgressRange', () => {
  it('返回阶段的起点百分比', () => {
    expect(getStageStartProgress(0, 5)).toBe(0);
    expect(getStageStartProgress(2, 5)).toBe(40);
    expect(getStageStartProgress(4, 5)).toBe(80);
  });

  it('无数据时退化为整段', () => {
    expect(getStageStartProgress(0, 0)).toBe(0);
    expect(getStageProgressRange(0, 0)).toEqual({ start: 0, end: 100 });
  });

  it('区间首尾相接，末阶段收在 100', () => {
    const count = 4;
    const ranges = Array.from({ length: count }, (_, i) => getStageProgressRange(i, count));
    expect(ranges[0]).toEqual({ start: 0, end: 25 });
    expect(ranges[3]).toEqual({ start: 75, end: 100 });
    for (let i = 1; i < count; i += 1) {
      expect(ranges[i].start).toBeCloseTo(ranges[i - 1].end, 10);
    }
  });

  it('越界索引会被收敛', () => {
    expect(getStageStartProgress(-5, 5)).toBe(0);
    expect(getStageStartProgress(99, 5)).toBe(80);
  });
});

describe('deriveStageSequence —— 从数据推导全局阶段顺序', () => {
  const makeEntry = (char: string, names: string[]): GlyphEntry => ({
    char,
    stages: names.map((name) => ({ name, era: '', svg: '' })),
  });

  it('所有字阶段一致时按原顺序返回', () => {
    const entries = [
      makeEntry('日', ['甲骨文', '金文', '小篆', '隶书', '楷书']),
      makeEntry('月', ['甲骨文', '金文', '小篆', '隶书', '楷书']),
    ];
    expect(deriveStageSequence(entries)).toEqual(['甲骨文', '金文', '小篆', '隶书', '楷书']);
  });

  it('部分字缺阶段时仍能推导出正确顺序', () => {
    const entries = [
      makeEntry('日', ['甲骨文', '金文', '小篆', '隶书', '楷书']),
      // 缺金文
      makeEntry('火', ['甲骨文', '小篆', '隶书', '楷书']),
      // 缺甲骨文与金文
      makeEntry('口', ['小篆', '隶书', '楷书']),
    ];
    expect(deriveStageSequence(entries)).toEqual(['甲骨文', '金文', '小篆', '隶书', '楷书']);
  });

  it('空数据返回空数组', () => {
    expect(deriveStageSequence([])).toEqual([]);
    expect(deriveStageSequence([makeEntry('日', [])])).toEqual([]);
  });
});
