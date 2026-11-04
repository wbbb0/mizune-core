/** Content logging is opt-in at the caller. Credentials and media capability URLs are never included. */
export function projectQqMessageDiagnostic(type: string, value: unknown): Record<string, unknown> {
  const record = (input: unknown): Record<string, unknown> => input != null && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  let nodes = 200;
  let characters = 24_000;
  const visited = new WeakSet<object>();
  function text(input: unknown): string | undefined {
    if (typeof input !== "string") return undefined;
    const result = input.slice(0, Math.max(0, characters)); characters -= result.length; return result;
  }
  function keys(input: readonly unknown[]): string[] {
    const result: string[] = [];
    for (const value of input.slice(0, 50)) {
      if (characters <= 0) break;
      if (typeof value !== "string") continue;
      const key = text(value.slice(0, 160));
      if (key) result.push(key);
    }
    return result;
  }
  function node(input: unknown, depth: number): Record<string, unknown> {
    const item = record(input);
    if (nodes <= 0) return { truncated: true };
    nodes -= 1;
    if (depth > 6 || visited.has(item)) return { truncated: true };
    visited.add(item);
    const author = record(item.author);
    const ext = record(item.message_scene).ext;
    const elements: Record<string, unknown>[] = [];
    const incomingElements = Array.isArray(item.msg_elements) ? item.msg_elements : [];
    for (const element of incomingElements.slice(0, 200)) {
      if (nodes <= 0) break;
      elements.push(node(element, depth + 1));
    }
    const result = {
      fieldNames: keys(Object.keys(item)),
      id: text(item.id), group_openid: text(item.group_openid),
      message_type: typeof item.message_type === "number" ? item.message_type : null,
      content: text(item.content), msg_idx: text(item.msg_idx),
      author: { id: text(author.id), user_openid: text(author.user_openid), member_openid: text(author.member_openid), username: text(author.username), bot: author.bot === true },
      mentions: (Array.isArray(item.mentions) ? item.mentions : []).slice(0, 50).map(raw => {
        const mention = record(raw);
        return { id: text(mention.id), user_openid: text(mention.user_openid), member_openid: text(mention.member_openid),
          is_you: mention.is_you === true, bot: mention.bot === true, scope: text(mention.scope) };
      }),
      attachmentMetadata: (Array.isArray(item.attachments) ? item.attachments : []).slice(0, 16).map(raw => {
        const attachment = record(raw);
        return { content_type: text(attachment.content_type), filename: text(attachment.filename), hasUrl: typeof attachment.url === "string" };
      }),
      // Only key names are useful for structure diagnostics. In particular auth_token values are omitted.
      extensionKeys: keys((Array.isArray(ext) ? ext : []).slice(0, 50).flatMap(raw => typeof raw === "string" ? [raw.split("=", 1)[0]] : [])),
      msg_elements: elements,
      ...(elements.length < incomingElements.length ? { truncated: true } : {})
    };
    return result;
  }
  return { eventType: type, message: node(value, 0) };
}
