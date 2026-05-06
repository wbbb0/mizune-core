export class ShellOutputBuffer {
  private value = "";
  private truncatedSinceDrain = false;

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    if (!chunk) {
      return;
    }
    const incoming = chunk.length > this.maxChars ? chunk.slice(chunk.length - this.maxChars) : chunk;
    if (chunk.length > this.maxChars) {
      this.truncatedSinceDrain = true;
    }
    const next = this.value + incoming;
    if (next.length > this.maxChars) {
      this.value = next.slice(next.length - this.maxChars);
      this.truncatedSinceDrain = true;
      return;
    }
    this.value = next;
  }

  tail(): string {
    return this.value;
  }

  drain(): { output: string; truncated: boolean } {
    const output = this.value;
    const truncated = this.truncatedSinceDrain;
    this.value = "";
    this.truncatedSinceDrain = false;
    return { output, truncated };
  }
}
