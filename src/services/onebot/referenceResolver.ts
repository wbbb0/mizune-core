import type { MessageContentPart } from "#messages/contentParts.ts";
import { parseChatSessionIdentity } from "#conversation/session/sessionIdentity.ts";
import { extractContentParts } from "./messageSegments.ts";
import type { OneBotClient } from "./onebotClient.ts";
import type { OneBotMessageSegment } from "./types.ts";
import type { MediaLocator, MediaScope } from "#services/workspace/mediaSources/types.ts";

type Budget = { nodes: number; media: number; text: number; requests: number; ancestors: Set<string>; signal: AbortSignal };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const label = (value: unknown) => value == null ? "" : String(value).slice(0, 160);

/** Platform queries only. Asset import and retry state live in the shared media service. */
export class OneBotReferenceResolver {
  constructor(private readonly client: Pick<OneBotClient, "getMessage" | "getForwardMessage">, private readonly connectionId: string,
    private readonly isOwnSessionMessage: (scope: MediaScope, id: string) => boolean = () => false) {}

  async expand(scope: MediaScope, parts: readonly MessageContentPart[]): Promise<MessageContentPart[]> {
    this.assertScope(scope);
    return this.expandParts(scope, parts, 0, { nodes: 200, media: 16, text: 24_000, requests: 8,
      ancestors: new Set(), signal: AbortSignal.timeout(10000) });
  }

  async refresh(scope: MediaScope, locator: MediaLocator, parentSignal?: AbortSignal): Promise<string | null> {
    this.assertScope(scope);
    const timeout = AbortSignal.timeout(10000);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    let segments: OneBotMessageSegment[];
    if (locator.kind === "onebot_message") {
      const message = await this.client.getMessage(locator.id, signal);
      this.assertMessageScope(scope, locator.id, message.group_id, message.user_id);
      segments = message.message;
    } else {
      const entries = await this.client.getForwardMessage(locator.id, signal);
      segments = this.entry(entries[locator.nodeIndex]).segments;
    }
    const image = extractContentParts(segments).filter(part => part.kind === "image" || part.kind === "emoji")[locator.imageIndex];
    return image && (image.kind === "image" || image.kind === "emoji") ? image.source ?? null : null;
  }

  async readMessage(scope: MediaScope, id: string) {
    this.assertScope(scope);
    const message = await this.client.getMessage(id, AbortSignal.timeout(10000));
    this.assertMessageScope(scope, id, message.group_id, message.user_id);
    return { message, parts: await this.expand(scope, this.located(message.message, { kind: "onebot_message", id })) };
  }

  private assertScope(scope: MediaScope) {
    const identity = parseChatSessionIdentity(scope.sessionId);
    if (!identity || identity.source !== "onebot" || identity.channelId !== this.connectionId || scope.connectionId !== this.connectionId) {
      throw new Error("引用不属于当前 OneBot 连接");
    }
  }

  private assertMessageScope(scope: MediaScope, id: string, groupId: number | null | undefined, userId: number | null | undefined) {
    const identity = parseChatSessionIdentity(scope.sessionId)!;
    if (identity.kind === "group" && String(groupId) !== identity.groupId) throw new Error("引用消息不属于当前群");
    if (identity.kind === "private" && groupId != null) throw new Error("私聊不能展开其他群的消息");
    if (identity.kind === "private" && String(userId) !== identity.userId && !this.isOwnSessionMessage(scope, id)) {
      throw new Error("无法证明引用属于当前私聊");
    }
  }

  private entry(value: unknown) {
    const outer = record(value);
    const item = outer.type === "node" ? record(outer.data) : outer;
    const sender = record(item.sender);
    const raw = item.content ?? item.message;
    return { segments: Array.isArray(raw) ? raw as OneBotMessageSegment[] : [],
      senderName: label(item.name || item.nickname || sender.card || sender.nickname),
      senderId: label(item.uin || item.user_id || sender.user_id) };
  }

  private located(segments: OneBotMessageSegment[], locator: Omit<Extract<MediaLocator, { kind: "onebot_message" }>, "imageIndex"> |
    Omit<Extract<MediaLocator, { kind: "onebot_forward" }>, "imageIndex">): MessageContentPart[] {
    let imageIndex = 0;
    return extractContentParts(segments).map(part => part.kind === "image" || part.kind === "emoji"
      ? { ...part, mediaLocator: { ...locator, imageIndex: imageIndex++ } } : part);
  }

  private async expandParts(scope: MediaScope, parts: readonly MessageContentPart[], depth: number, budget: Budget): Promise<MessageContentPart[]> {
    const result: MessageContentPart[] = [];
    for (const part of parts.slice(0, 200)) {
      if (depth > 5 || budget.nodes-- <= 0) { result.push({ kind: "special", segmentType: "reference_truncated", summary: "部分引用因数量或层级限制未展开。" }); break; }
      if (part.kind === "text") {
        result.push({ ...part, text: part.text.slice(0, budget.text) }); budget.text = Math.max(0, budget.text - part.text.length); continue;
      }
      if (part.kind === "image" || part.kind === "emoji") {
        if (budget.media-- > 0) result.push(part);
        else result.push({ kind: "special", segmentType: "reference_truncated", summary: "图片数量超限，未展开。" });
        continue;
      }
      if (part.kind === "embedded_message") {
        result.push({ ...part, parts: await this.expandParts(scope, part.parts, depth + 1, budget) }); continue;
      }
      if (part.kind !== "reply" && part.kind !== "forward") { result.push(part); continue; }
      const id = part.kind === "reply" ? part.messageId : part.forwardId;
      const key = `${part.kind}:${id}`;
      if (budget.ancestors.has(key) || budget.requests <= 0 || budget.signal.aborted || depth >= 5) { result.push(part); continue; }
      budget.requests -= 1;
      budget.ancestors.add(key);
      try {
        if (part.kind === "reply") {
          const message = await this.client.getMessage(id, budget.signal);
          this.assertMessageScope(scope, id, message.group_id, message.user_id);
          const sender = record(message.sender);
          result.push({ kind: "embedded_message", relation: "reply", messageId: id,
            senderId: label(message.user_id), senderName: label(sender.card || sender.nickname),
            parts: await this.expandParts(scope, this.located(message.message, { kind: "onebot_message", id }), depth + 1, budget) });
        } else {
          const entries = await this.client.getForwardMessage(id, budget.signal);
          const nodes: MessageContentPart[] = [];
          for (let index = 0; index < Math.min(entries.length, 100) && budget.nodes > 0; index++) {
            budget.nodes -= 1;
            const node = this.entry(entries[index]);
            nodes.push({ kind: "embedded_message", relation: "message", senderName: node.senderName, senderId: node.senderId,
              parts: await this.expandParts(scope, this.located(node.segments, { kind: "onebot_forward", id, nodeIndex: index }), depth + 2, budget) });
          }
          result.push({ kind: "embedded_message", relation: "forward", messageId: id, parts: nodes,
            ...(entries.length > nodes.length ? { truncated: true } : {}) });
        }
      } catch { result.push(part); }
      finally { budget.ancestors.delete(key); }
    }
    return result;
  }
}
