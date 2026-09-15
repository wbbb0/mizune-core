import { AnthropicMessagesProvider } from "./anthropicMessagesProvider.ts";

export class DeepSeekProvider extends AnthropicMessagesProvider {
  constructor() { super("deepseek"); }
}
