import { AnthropicMessagesProvider } from "./anthropicMessagesProvider.ts";

export class AnthropicProvider extends AnthropicMessagesProvider {
  constructor() { super("anthropic"); }
}
