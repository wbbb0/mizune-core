export interface ExtractedUserFactCandidate {
  title: string;
  content: string;
  kind?: ExtractedUserFactKind;
}

type ExtractedUserFactKind = "preference" | "fact" | "boundary" | "habit" | "relationship" | "other";

export function extractExplicitUserFactCandidates(text: string): ExtractedUserFactCandidate[] {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500) {
    return [];
  }
  if (isQuestionLikeUserText(trimmed)) {
    return [];
  }
  return extractRememberFact(trimmed) ?? extractDurableSelfStatement(trimmed) ?? [];
}

function extractRememberFact(trimmed: string): ExtractedUserFactCandidate[] | null {
  const match = /^(?:请|帮我|麻烦)?(?:你)?记住[：:\s]*(?<content>[\s\S]{2,200})$/u.exec(trimmed)
    ?? /^(?:以后|之后)(?:请|帮我|麻烦)?(?:你)?记住[：:\s]*(?<content>[\s\S]{2,200})$/u.exec(trimmed);
  const content = match?.groups?.content?.trim();
  if (!content || /^(?:一下|这件事|这个|这些|吧|哦|哈)+$/u.test(content)) {
    return null;
  }
  const normalized = normalizeFactContent(content);
  if (normalized.length < 2) {
    return null;
  }
  return [{
    title: normalized.length > 24 ? `${normalized.slice(0, 24)}...` : normalized,
    content: normalized,
    kind: "preference"
  }];
}

function extractDurableSelfStatement(trimmed: string): ExtractedUserFactCandidate[] | null {
  const normalizedInput = stripReplyInstruction(trimmed.replace(/^(?:更新一下|改一下|补充一下)[，,：:\s]*/u, ""));
  const match = /^我(?<topic>[\p{Script=Han}A-Za-z0-9_]{1,12}?)(?<statement>(?:(?:固定|一般|通常|经常|现在|以后|之后)(?:吃|喝|用|使用)|(?:改成|换成|不再|喜欢|不喜欢|偏好))[\s\S]{1,160})$/u.exec(normalizedInput);
  const topic = match?.groups?.topic?.trim();
  const statement = match?.groups?.statement?.trim();
  if (!topic || !statement || GENERIC_SELF_STATEMENT_TOPICS.has(topic)) {
    return null;
  }
  const content = normalizeFactContent(`${topic}${statement}`);
  if (content.length < 4) {
    return null;
  }
  return [{
    title: buildSelfStatementTitle(topic),
    content,
    kind: buildSelfStatementKind(topic)
  }];
}

function stripReplyInstruction(text: string): string {
  return text
    .replace(/[，,。；;]?(?:你)?先?回复[\s\S]*$/u, "")
    .replace(/[，,。；;]?不用多说[\s\S]*$/u, "")
    .trim();
}

function normalizeFactContent(text: string): string {
  return text.replace(/[。！？!?\s]+$/u, "").trim();
}

function isQuestionLikeUserText(text: string): boolean {
  return /[?？]/u.test(text) || QUESTION_TERMS.some((term) => text.includes(term));
}

function buildSelfStatementTitle(topic: string): string {
  if (/(早餐|午餐|晚餐|宵夜|饮食|咖啡|茶|夜宵)/u.test(topic)) {
    return `${topic}习惯`;
  }
  if (/(称呼|名字|昵称|叫法)/u.test(topic)) {
    return "称呼偏好";
  }
  return `${topic}偏好`;
}

function buildSelfStatementKind(topic: string): ExtractedUserFactKind {
  return /(早餐|午餐|晚餐|宵夜|饮食|咖啡|茶|夜宵|作息|睡眠|运动)/u.test(topic)
    ? "habit"
    : "preference";
}

const GENERIC_SELF_STATEMENT_TOPICS = new Set([
  "也",
  "还是",
  "现在",
  "以后",
  "之后",
  "一般",
  "通常",
  "经常"
]);

const QUESTION_TERMS = [
  "什么",
  "吗",
  "呢",
  "多少",
  "几",
  "谁",
  "哪里",
  "哪儿",
  "为何",
  "为什么",
  "怎么",
  "如何",
  "能否",
  "是否"
];
