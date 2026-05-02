export class OpenAICompatError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenAICompatError";
  }
}

export class OpenAICompatEmbeddingClient {
  constructor({ config, model }) {
    this.config = config;
    this.model = model;
  }

  async embedTexts(texts) {
    if (texts.length === 0) {
      return [];
    }
    try {
      const response = await this.postJson("/embeddings", {
        model: this.model,
        input: texts,
      });
      return parseEmbeddingVectors(response);
    } catch (error) {
      if (texts.length === 1 || !isRetryableBatchError(error)) {
        throw error;
      }
      const vectors = [];
      for (const text of texts) {
        vectors.push(await this.embedSingleText(text));
      }
      return vectors;
    }
  }

  async embedSingleText(text) {
    const response = await this.postJson("/embeddings", {
      model: this.model,
      input: text,
    });
    return parseEmbeddingVectors(response)[0];
  }

  async postJson(path, payload) {
    return postJson(this.config, path, payload);
  }
}

export class OpenAICompatChatClient {
  constructor({ config, model }) {
    this.config = config;
    this.model = model;
  }

  async complete(messages, temperature = 0.2) {
    const body = await postJson(this.config, "/chat/completions", {
      model: this.model,
      messages,
      temperature,
    });
    const choice = body?.choices?.[0];
    const message = choice?.message;
    if (!message || typeof message.content !== "string") {
      throw new OpenAICompatError("chat response missing assistant content");
    }
    const usage = body.usage && typeof body.usage === "object" ? body.usage : {};
    const completionDetails = usage.completion_tokens_details && typeof usage.completion_tokens_details === "object"
      ? usage.completion_tokens_details
      : {};
    return {
      content: message.content,
      reasoningContent: extractReasoningContent(message),
      finishReason: choice.finish_reason ?? null,
      promptTokens: maybeInt(usage.prompt_tokens),
      completionTokens: maybeInt(usage.completion_tokens),
      totalTokens: maybeInt(usage.total_tokens),
      reasoningTokens: maybeInt(completionDetails.reasoning_tokens),
    };
  }
}

export class LMStudioManagementClient {
  constructor({ config }) {
    this.config = config;
  }

  async ensureModelLoaded(model, timeoutMs = 600_000) {
    const loadedInstanceId = await this.getLoadedInstanceId(model);
    if (loadedInstanceId) {
      return;
    }
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/v1/models/load`;
    const response = await fetchWithTimeout(endpoint, {
      method: "POST",
      timeoutMs,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model }),
    });
    await parseResponseJson(response);
  }

  async getLoadedInstanceId(model) {
    const endpoint = `${this.config.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/v1/models`;
    const response = await fetchWithTimeout(endpoint, {
      method: "GET",
      timeoutMs: this.config.timeoutMs,
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
      },
    });
    const body = await parseResponseJson(response);
    for (const item of body.models ?? []) {
      if (item.key !== model) {
        continue;
      }
      const loadedInstances = item.loaded_instances ?? [];
      if (loadedInstances.length > 0) {
        return String(loadedInstances[0].id);
      }
    }
    return null;
  }
}

async function postJson(config, path, payload) {
  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}${path}`;
  const response = await fetchWithTimeout(endpoint, {
    method: "POST",
    timeoutMs: config.timeoutMs,
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return parseResponseJson(response);
}

async function fetchWithTimeout(url, { timeoutMs, ...init }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function parseResponseJson(response) {
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch (error) {
    throw new OpenAICompatError(`invalid JSON response: ${error.message}`);
  }
  if (!response.ok) {
    const message = body?.error ? JSON.stringify(body.error) : `${response.status} ${response.statusText}`;
    throw new OpenAICompatError(message);
  }
  if (body && typeof body === "object" && body.error) {
    throw new OpenAICompatError(JSON.stringify(body.error));
  }
  return body;
}

function parseEmbeddingVectors(response) {
  if (!Array.isArray(response.data)) {
    throw new OpenAICompatError("embedding response missing data list");
  }
  return [...response.data]
    .sort((a, b) => Number(a.index) - Number(b.index))
    .map((item) => item.embedding);
}

function isRetryableBatchError(error) {
  return error instanceof OpenAICompatError && !/^4\d\d /.test(error.message);
}

function extractReasoningContent(message) {
  for (const key of ["reasoning_content", "reasoning"]) {
    const value = message[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (value && typeof value === "object") {
      for (const nestedKey of ["content", "text"]) {
        const nestedValue = value[nestedKey];
        if (typeof nestedValue === "string" && nestedValue.trim()) {
          return nestedValue.trim();
        }
      }
    }
  }
  return null;
}

function maybeInt(value) {
  return Number.isInteger(value) ? value : null;
}
