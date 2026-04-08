export interface GenerationWebOutputCollector {
  append: (chunk: string) => Promise<void> | void;
}
