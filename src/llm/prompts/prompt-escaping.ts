export function escapePromptBodyText(text: string): string {
  return text
    .replace(/⟦/g, "[")
    .replace(/⟧/g, "]");
}
