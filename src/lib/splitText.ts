/**
 * 文本拆分：把用户输入切成「单字 token」。
 *
 * 约定：
 * - 汉字（含扩展 A/B 区等）标记为 isHan，参与字形切换；
 * - 空格、换行、标点等非汉字保留为占位 token，只渲染成灰色占位格，不参与字形切换；
 * - 使用 Array.from 按码位遍历，避免把扩展区汉字的代理对拆坏。
 */

/** 拆分后的最小单元。 */
export interface TextToken {
  /** React key，保证同一位置稳定。 */
  key: string;
  /** 单个字符（可能是汉字、标点或空格）。 */
  char: string;
  /** 是否为汉字（参与字形切换）。 */
  isHan: boolean;
  /** 是否为空白字符。 */
  isSpace: boolean;
  /** 在原文中的码位下标。 */
  index: number;
}

/** 汉字判定：基本区、扩展 A、兼容区、扩展 B 及以后。 */
const HAN_PATTERN =
  /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[\u{20000}-\u{2FA1F}\u{30000}-\u{323AF}]/u;

const SPACE_PATTERN = /^\s$/;

/** 判断单个字符是否为汉字。 */
export function isHanChar(char: string): boolean {
  return HAN_PATTERN.test(char);
}

/**
 * 把一段文本拆成 token 数组。
 *
 * @example
 * splitText('日月 山水').map(t => t.char) // ['日','月',' ','山','水']
 * splitText('日月 山水')[2].isHan          // false
 */
export function splitText(text: string): TextToken[] {
  const chars = Array.from(text ?? '');
  return chars.map((char, index) => ({
    key: `${index}-${char}`,
    char,
    isHan: isHanChar(char),
    isSpace: SPACE_PATTERN.test(char),
    index,
  }));
}

/** 统计文本中的汉字数量（用于界面提示）。 */
export function countHanChars(tokens: TextToken[]): number {
  return tokens.reduce((sum, token) => (token.isHan ? sum + 1 : sum), 0);
}
