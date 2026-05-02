export interface AdmissionTextIntent {
  correction: boolean;
  waitMore: boolean;
}

const WAIT_MORE_PATTERNS = [
  /(?:等下|等等|稍等|等我|先别回|先别急|别急|别回复|暂时别回|还没说完)/u,
  /(?:我(?:贴|发|整理|补|接着|继续发)|后面还有|还有[一二两三四五六七八九十\d]*[段条个]|下一段|下段|发完再说|完整日志|日志太长)/u
] as const;

const CORRECTION_PATTERNS = [
  /(?:不对|错了|有误|搞错了|说错了|我说错了|刚才说错了|上一条错了)/u,
  /(?:不是(?:这个|那个|这[样么]|那[样么]|这个意思|那个意思)|应该是|应该改成|改一下|改成|重新来|重来)/u,
  /(?:别管.*?了|不用.*?了|别用.*?了)/u
] as const;

export function analyzeAdmissionTextIntent(text: string): AdmissionTextIntent {
  const normalized = text.trim();
  return {
    correction: matchesAny(CORRECTION_PATTERNS, normalized),
    waitMore: matchesAny(WAIT_MORE_PATTERNS, normalized)
  };
}

function matchesAny(patterns: readonly RegExp[], text: string): boolean {
  return text.length > 0 && patterns.some((pattern) => pattern.test(text));
}
