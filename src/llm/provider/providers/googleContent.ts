import { resolveAiStudioEndpoint } from "./googleEndpoint.ts";
import { isDeepStrictEqual } from "node:util";
import type { Content, Part } from "@google/genai";
import type { LlmContentPart, LlmMessage, LlmProviderRequestContext } from "../providerTypes.ts";
import { canReplayGoogleParts, isGooglePart } from "../../shared/googleReplay.ts";

const mediaPolicy = { createInlineDataError: () => new Error("Gemini 媒体输入需要 base64 data URL") };

export function googlePlainText(content: LlmMessage["content"]): string {
  return typeof content === "string" ? content : content.filter(part => part.type === "text").map(part => part.text).join("\n");
}

/** Invalid signed histories become observations, never synthetic tool requests. */
export function buildGoogleContents(context: LlmProviderRequestContext, messages: LlmMessage[]): Content[] {
  const contents: Content[] = [];
  const calls = new Map<string, { name: string; upstreamId?: string; observation: boolean }>();
  let pending: Part[] = [];
  const flush = () => { if (pending.length) contents.push({ role: "user", parts: pending }); pending = []; };
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const id = message.tool_call_id ?? "";
      const call = calls.get(id);
      if (!call) throw new Error(`Google 历史工具结果无法关联调用: ${id}`);
      calls.delete(id);
      if (call.observation) {
        pending.push({ text: `[不可信历史工具结果 ${call.name}]\n${googlePlainText(message.content)}` });
      } else {
        let response: Record<string, unknown>;
        const text = googlePlainText(message.content);
        try { const parsed: unknown = JSON.parse(text); response = isGooglePart(parsed) ? parsed : { content: text }; }
        catch { response = { content: text }; }
        pending.push({ functionResponse: { name: call.name, ...(call.upstreamId && context.providerConfig.type !== "vertex_express" ? { id: call.upstreamId } : {}), response } });
      }
      continue;
    }
    flush();
    if (calls.size) throw new Error("Google 历史工具调用缺少结果，不能静默丢弃");
    if (message.role === "user") {
      contents.push({ role: "user", parts: convertContentToGoogleParts(message.content, mediaPolicy) });
      continue;
    }
    const metadata = message.providerMetadata;
    const raw = Array.isArray(metadata?.googleParts) ? metadata.googleParts : undefined;
    const scope = metadata?.googleReplayScope;
    const scopeMatches = isDeepStrictEqual(scope, googleReplayScope(context));
    const requireSignature = (context.modelProfile[context.operation ?? "chat"]?.capabilities.supportsThinking !== false);
    let replay = !!(raw && !metadata?.googleReplayInvalidated && scopeMatches && canReplayGoogleParts(raw, requireSignature) && (context.providerConfig.type === "google" || !raw.some(part => isGooglePart(part) && (part.toolCall || part.toolResponse))));
    const localCalls = message.tool_calls ?? [];
    const rawCalls = replay ? raw!.filter(part => isGooglePart(part) && part.functionCall).map(part => (part as Part).functionCall!) : [];
    const byId = new Map(rawCalls.filter(call => call.id).map(call => [call.id!, call]));
    const associatedCalls = localCalls.map((call, index) => byId.get(call.id) ?? (!rawCalls[index]?.id ? rawCalls[index] : undefined));
    if (rawCalls.length !== localCalls.length || byId.size !== rawCalls.filter(call => call.id).length) replay = false;
    localCalls.forEach((call, index) => {
      const upstream = associatedCalls[index];
      let args: unknown;
      try { args = JSON.parse(call.function.arguments); } catch { replay = false; }
      if (!upstream || upstream.name !== call.function.name || !isDeepStrictEqual(upstream.args ?? {}, args)) replay = false;
    });
    const ids = new Set<string>();
    localCalls.forEach((call, index) => {
      if (!call.id || ids.has(call.id)) throw new Error("Google 历史工具调用 ID 冲突");
      ids.add(call.id);
      const upstream = replay ? associatedCalls[index] : undefined;
      calls.set(call.id, { name: call.function.name, ...(upstream?.id ? { upstreamId: upstream.id } : {}), observation: !replay });
    });
    if (replay) {
      const replayParts = structuredClone(raw!) as Part[];
      if (context.providerConfig.type === "vertex_express") {
        for (const part of replayParts) { if (part.functionCall) delete part.functionCall.id; if (part.functionResponse) delete part.functionResponse.id; }
      }
      contents.push({ role: "model", parts: replayParts });
    } else {
      const parts = convertContentToGoogleParts(message.content, mediaPolicy);
      if (localCalls.length) parts.push({ text: `[不可信历史工具调用记录；已执行，无需重复执行]\n${localCalls.map(call => `${call.function.name}(${call.function.arguments})`).join("\n")}` });
      if (parts.length) contents.push({ role: "model", parts });
    }
  }
  flush();
  if (calls.size) throw new Error("Google 历史工具调用缺少结果");
  return contents;
}

export function convertContentToGoogleParts(
  content: string | LlmContentPart[],
  compatibility: { createInlineDataError(): Error }
): Part[] {
  if (typeof content === "string") {
    return content.length > 0 ? [{ text: content }] : [];
  }

  const parts: Part[] = [];
  for (const part of content) {
    if (part.type === "text") {
      if (part.text.length > 0) {
        parts.push({ text: part.text });
      }
      continue;
    }

    if (part.type === "image_url" || part.type === "video_url") {
      const inlineData = dataUrlToBase64(part.type === "video_url" ? part.video_url.url : part.image_url.url);
      if (!inlineData) {
        throw compatibility.createInlineDataError();
      }
      parts.push({
        inlineData,
        ...(part.type === "video_url" && part.fps !== undefined ? { videoMetadata: { fps: part.fps } } : {})
      });
      continue;
    }

    parts.push({
      inlineData: {
        mimeType: part.input_audio.mimeType ?? inferAudioMimeType(part.input_audio.format),
        data: part.input_audio.data
      }
    });
  }

  return parts;
}


function dataUrlToBase64(dataUrl: string): { mimeType: string; data: string } | null {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/i);
  if (!match) {
    return null;
  }

  return {
    mimeType: String(match[1] ?? "application/octet-stream"),
    data: String(match[2] ?? "")
  };
}

function inferAudioMimeType(format: string): string {
  const normalized = String(format).trim().toLowerCase();
  switch (normalized) {
    case "mp3":
    case "mpeg":
    case "mpga":
      return "audio/mpeg";
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm";
    case "ogg":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    case "aac":
      return "audio/aac";
    case "amr":
      return "audio/amr";
    default:
      return "audio/mpeg";
  }
}


export function googleReplayScope(context: LlmProviderRequestContext) {
  const endpoint = context.providerConfig.type === "google" ? resolveAiStudioEndpoint(context.baseUrl) : { baseUrl: context.baseUrl.replace(/\/+$/, ""), apiVersion: "" };
  return { model: context.model, providerName: context.providerName, providerType: context.providerConfig.type, ...endpoint };
}
