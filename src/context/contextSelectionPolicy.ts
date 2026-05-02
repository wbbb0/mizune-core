import type { ContextRetrievedItem } from "./contextTypes.ts";
import { contextTermOverlapScore, informativeContextTerms, normalizedContextText } from "./contextTextTerms.ts";

export function selectRetrievedUserContext(input: {
  queryText: string;
  alwaysItems: ContextRetrievedItem[];
  searchItems: ContextRetrievedItem[];
  maxResults: number;
}): ContextRetrievedItem[] {
  const selectedSearchItems = suppressStaleSearchItems(input.queryText, input.alwaysItems, input.searchItems);
  return [...input.alwaysItems, ...selectedSearchItems].slice(0, input.maxResults);
}

function suppressStaleSearchItems(
  queryText: string,
  alwaysItems: ContextRetrievedItem[],
  searchItems: ContextRetrievedItem[]
): ContextRetrievedItem[] {
  const canonicalFacts = alwaysItems.filter((item) => item.sourceType === "fact");
  if (canonicalFacts.length === 0 || isHistoricalQuery(queryText)) {
    return searchItems;
  }
  return searchItems.filter((item) => {
    if (item.sourceType !== "chunk" && item.sourceType !== "summary") {
      return true;
    }
    return !canonicalFacts.some((fact) => isStaleAgainstFact(queryText, item, fact));
  });
}

function isStaleAgainstFact(queryText: string, item: ContextRetrievedItem, fact: ContextRetrievedItem): boolean {
  if (item.updatedAt > fact.updatedAt) {
    return false;
  }
  if (!isSameInformationSlot(queryText, item, fact)) {
    return false;
  }
  return !containsCanonicalFactValue(item.text, fact.text);
}

function isSameInformationSlot(queryText: string, item: ContextRetrievedItem, fact: ContextRetrievedItem): boolean {
  const factTopicText = [fact.title, fact.text].filter(Boolean).join(" ");
  const queryTopicScore = contextTermOverlapScore(queryText, factTopicText);
  const itemTopicScore = contextTermOverlapScore(item.text, factTopicText);
  if (fact.title?.trim()) {
    const titleScore = contextTermOverlapScore(item.text, fact.title);
    const queryTitleScore = contextTermOverlapScore(queryText, fact.title);
    return titleScore >= 0.18 && queryTitleScore >= 0.18;
  }
  return queryTopicScore >= 0.18 && itemTopicScore >= 0.18;
}

function containsCanonicalFactValue(itemText: string, factText: string): boolean {
  const factTerms = informativeContextTerms(factText);
  if (factTerms.size === 0) {
    return normalizedContextText(itemText).includes(normalizedContextText(factText));
  }
  const itemTerms = informativeContextTerms(itemText);
  let covered = 0;
  for (const term of factTerms) {
    if (itemTerms.has(term)) {
      covered += 1;
    }
  }
  return covered / factTerms.size >= 0.62;
}

function isHistoricalQuery(text: string): boolean {
  return HISTORICAL_QUERY_TERMS.some((term) => text.includes(term));
}

const HISTORICAL_QUERY_TERMS = [
  "以前",
  "之前",
  "过去",
  "原来",
  "曾经",
  "当时",
  "历史",
  "旧的",
  "早先"
];
