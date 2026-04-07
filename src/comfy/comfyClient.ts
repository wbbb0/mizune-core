import type { Logger } from "pino";
import type { AppConfig } from "#config/config.ts";
import type { ComfyHistoryEntry, ComfyPromptSubmitResult } from "./types.ts";

export class ComfyClient {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger
  ) {}

  async submitPrompt(input: {
    workflow: Record<string, unknown>;
    clientId: string;
  }): Promise<ComfyPromptSubmitResult> {
    const response = await fetch(`${this.config.comfy.apiBaseUrl}/prompt`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        prompt: input.workflow,
        client_id: input.clientId
      }),
      signal: AbortSignal.timeout(this.config.comfy.submitTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Comfy submit failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json() as {
      prompt_id?: unknown;
      number?: unknown;
      node_errors?: unknown;
    };
    const promptId = String(payload.prompt_id ?? "").trim();
    if (!promptId) {
      throw new Error("Comfy submit failed: missing prompt_id");
    }
    return {
      promptId,
      queueNumber: Number(payload.number ?? 0),
      nodeErrors: isPlainObject(payload.node_errors) ? payload.node_errors : {}
    };
  }

  async getQueue(): Promise<{
    runningPromptIds: Set<string>;
    pendingPromptIds: Set<string>;
  }> {
    const response = await fetch(`${this.config.comfy.apiBaseUrl}/queue`, {
      signal: AbortSignal.timeout(this.config.comfy.submitTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Comfy queue failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json() as {
      queue_running?: unknown[];
      queue_pending?: unknown[];
    };
    const runningPromptIds = new Set(extractPromptIds(payload.queue_running));
    const pendingPromptIds = new Set(extractPromptIds(payload.queue_pending));
    return { runningPromptIds, pendingPromptIds };
  }

  async getHistory(promptId: string): Promise<ComfyHistoryEntry | null> {
    const response = await fetch(`${this.config.comfy.apiBaseUrl}/history/${encodeURIComponent(promptId)}`, {
      signal: AbortSignal.timeout(this.config.comfy.submitTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Comfy history failed: ${response.status} ${response.statusText}`);
    }
    const payload = await response.json() as Record<string, {
      outputs?: Record<string, { images?: Array<{ filename?: unknown; subfolder?: unknown; type?: unknown }> }>;
      status?: { completed?: unknown; status_str?: unknown };
    }>;
    const record = payload[promptId];
    if (!record) {
      return null;
    }
    const images = Object.values(record.outputs ?? {}).flatMap((output) => (
      output.images ?? []
    )).map((image) => ({
      filename: String(image.filename ?? "").trim(),
      subfolder: String(image.subfolder ?? ""),
      type: String(image.type ?? "output").trim() || "output"
    })).filter((image) => image.filename);
    return {
      promptId,
      completed: Boolean(record.status?.completed),
      status: String(record.status?.status_str ?? ""),
      images
    };
  }

  async downloadView(input: {
    filename: string;
    subfolder?: string;
    type?: string;
  }): Promise<Buffer> {
    const url = new URL(`${this.config.comfy.apiBaseUrl}/view`);
    url.searchParams.set("filename", input.filename);
    url.searchParams.set("type", input.type ?? "output");
    if (input.subfolder) {
      url.searchParams.set("subfolder", input.subfolder);
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(this.config.comfy.submitTimeoutMs)
    });
    if (!response.ok) {
      throw new Error(`Comfy view failed: ${response.status} ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }
}

function extractPromptIds(entries: unknown[] | undefined): string[] {
  if (!Array.isArray(entries)) {
    return [];
  }
  return entries.map((entry) => {
    if (!Array.isArray(entry)) {
      return "";
    }
    return String(entry[1] ?? "").trim();
  }).filter(Boolean);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
