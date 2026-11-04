import type { StateDatabase } from "./stateDatabase.ts";

export interface IncomingMessageReceipt {
  connectionId: string;
  chatType: "private" | "group";
  targetId: string;
  messageId: string;
  activated: boolean;
}
export type IncomingMessageReceiptClaim = "accepted" | "upgrade" | "duplicate";

const RECEIPT_TTL_MS = 10 * 60_000;
const MAX_RECEIPTS = 10_000;

/** Transport receipts survive clearing conversation history and contain no message content or reply permits. */
export class IncomingMessageReceiptStore {
  constructor(private readonly database: StateDatabase, private readonly now: () => number = Date.now) {}

  claim(input: IncomingMessageReceipt): IncomingMessageReceiptClaim {
    if ([input.connectionId, input.targetId, input.messageId].some(value => !value || value.length > 4096)) {
      throw new Error("非法入站消息来源标识");
    }
    const db = this.database.getDb();
    return db.transaction((): IncomingMessageReceiptClaim => {
      const now = this.now();
      db.prepare("DELETE FROM incoming_message_receipts WHERE expires_at_ms <= ?").run(now);
      const key = { connectionId: input.connectionId, chatType: input.chatType, targetId: input.targetId, messageId: input.messageId };
      const existing = db.prepare(`
        SELECT activated FROM incoming_message_receipts
        WHERE connection_id = @connectionId AND chat_type = @chatType AND target_id = @targetId AND message_id = @messageId
      `).get(key) as { activated: number } | undefined;
      if (existing) {
        if (existing.activated || !input.activated) return "duplicate";
        db.prepare(`
          UPDATE incoming_message_receipts SET activated = 1
          WHERE connection_id = @connectionId AND chat_type = @chatType AND target_id = @targetId AND message_id = @messageId
        `).run(key);
        return "upgrade";
      }
      const count = db.prepare("SELECT COUNT(*) AS count FROM incoming_message_receipts").get() as { count: number };
      if (count.count >= MAX_RECEIPTS) throw new Error("入站消息接收记录已达到容量上限");
      db.prepare(`
        INSERT INTO incoming_message_receipts (connection_id, chat_type, target_id, message_id, activated, expires_at_ms)
        VALUES (@connectionId, @chatType, @targetId, @messageId, @activated, @expiresAt)
      `).run({ ...key, activated: input.activated ? 1 : 0, expiresAt: now + RECEIPT_TTL_MS });
      return "accepted";
    }).immediate();
  }
}
