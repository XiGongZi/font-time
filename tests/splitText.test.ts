import { describe, expect, it } from 'vitest';
import { countHanChars, isHanChar, splitText } from '../src/lib/splitText';

describe('splitText', () => {
  it('把中文拆成单字', () => {
    const tokens = splitText('日月山水');
    expect(tokens.map((t) => t.char)).toEqual(['日', '月', '山', '水']);
    expect(tokens.every((t) => t.isHan)).toBe(true);
  });

  it('保留空格作为占位项，且不参与字形切换', () => {
    const tokens = splitText('日月 山水');
    expect(tokens.map((t) => t.char)).toEqual(['日', '月', ' ', '山', '水']);
    expect(tokens[2].isHan).toBe(false);
    expect(tokens[2].isSpace).toBe(true);
  });

  it('保留标点作为占位项', () => {
    const tokens = splitText('日，月。');
    expect(tokens.map((t) => t.char)).toEqual(['日', '，', '月', '。']);
    expect(tokens.filter((t) => t.isHan).map((t) => t.char)).toEqual(['日', '月']);
  });

  it('混合中英文与数字时只把汉字当作字形单元', () => {
    const tokens = splitText('日a月1');
    expect(tokens.map((t) => t.isHan)).toEqual([true, false, true, false]);
  });

  it('按码位遍历，扩展区汉字不被拆坏', () => {
    // U+20000 是扩展 B 区的汉字，UTF-16 下是代理对
    const tokens = splitText('日𠀀月');
    expect(tokens).toHaveLength(3);
    expect(tokens[1].char).toBe('𠀀');
    expect(tokens[1].isHan).toBe(true);
  });

  it('空文本返回空数组', () => {
    expect(splitText('')).toEqual([]);
  });

  it('每个 token 的 key 唯一', () => {
    const tokens = splitText('日月山水日月山水');
    expect(new Set(tokens.map((t) => t.key)).size).toBe(tokens.length);
  });

  it('token 的 index 与原文码位顺序一致', () => {
    const tokens = splitText('日月山水');
    expect(tokens.map((t) => t.index)).toEqual([0, 1, 2, 3]);
  });
});

describe('isHanChar', () => {
  it('识别基本区汉字', () => {
    expect(isHanChar('日')).toBe(true);
    expect(isHanChar('龘')).toBe(true);
  });

  it('排除标点、字母、数字、空白', () => {
    expect(isHanChar('，')).toBe(false);
    expect(isHanChar('a')).toBe(false);
    expect(isHanChar('1')).toBe(false);
    expect(isHanChar(' ')).toBe(false);
  });
});

describe('countHanChars', () => {
  it('只统计汉字', () => {
    expect(countHanChars(splitText('日月 山水，人'))).toBe(5);
    expect(countHanChars(splitText(''))).toBe(0);
  });
});
