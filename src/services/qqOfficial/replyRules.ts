// 官方消息收发概述及发送接口的行为说明为准（2026-10）；字段表仍有旧的 5 分钟说明。
export const QQ_REPLY_RULES = {
  private: { lifetimeMs: 60 * 60_000, maxMessages: 4 },
  group: { lifetimeMs: 5 * 60_000, maxMessages: 5 }
} as const;
