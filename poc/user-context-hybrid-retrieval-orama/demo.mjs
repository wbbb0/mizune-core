#!/usr/bin/env node

import {
  DEFAULT_CHAT_BASE_URL,
  DEFAULT_CHAT_MODEL,
  DEFAULT_EMBEDDING_MODEL,
  resolveDemoRuntime,
} from "./src/demo-runtime.mjs";
import { defaultDemoName, demoNames, getDemoScenario } from "./src/demo-data.mjs";
import {
  LMStudioManagementClient,
  OpenAICompatChatClient,
  OpenAICompatEmbeddingClient,
  OpenAICompatError,
} from "./src/openai-compat.mjs";
import {
  ORAMA_HYBRID_WEIGHT,
  RECENCY_WEIGHT,
  SUMMARY_BONUS,
  OramaHybridContextRetriever,
} from "./src/retriever.mjs";

function main() {
  return run().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  });
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  if (!args.apiKey) {
    console.error("Missing API key. Set POC_OPENAI_API_KEY or pass --api-key.");
    return 2;
  }

  const style = new AnsiStyle(!args.plain && process.stdout.isTTY);
  const scenario = getDemoScenario(args.demo);
  const runtime = resolveDemoRuntime(args, scenario);
  const embeddingClient = new OpenAICompatEmbeddingClient({
    config: runtime.embeddingConfig,
    model: runtime.embeddingModel,
  });
  const retriever = new OramaHybridContextRetriever({ embeddingClient });
  await retriever.indexChunks(scenario.chunks);

  const debug = await retriever.retrieveDebug({
    userId: runtime.userId,
    queryText: runtime.queryText,
    limit: 3,
  });

  console.log(section(style, "Query"));
  console.log(formatQueryBlock({
    scenario,
    userId: runtime.userId,
    queryText: runtime.queryText,
    embeddingModel: runtime.embeddingModel,
    embeddingBaseUrl: runtime.embeddingConfig.baseUrl,
    chatModel: runtime.chatModel,
    chatBaseUrl: runtime.chatConfig.baseUrl,
  }));

  console.log(section(style, "Retrieved Context"));
  for (const item of debug.selected) {
    console.log(formatSelectedItem(style, item));
  }

  if (!args.hideRetrievalReasoning) {
    console.log(section(style, "Retrieval Reasoning"));
    console.log(formatRetrievalReasoning(style, debug, args.candidateLimit));
  }

  if (args.skipChat) {
    return 0;
  }

  if (args.loadChatModel) {
    const manager = new LMStudioManagementClient({ config: runtime.chatConfig });
    console.log(section(style, "Model Load"));
    console.log(style.subtle(`Ensuring chat model is loaded: ${runtime.chatModel}`));
    await manager.ensureModelLoaded(runtime.chatModel);
  }

  const chatClient = new OpenAICompatChatClient({
    config: runtime.chatConfig,
    model: runtime.chatModel,
  });
  const prompt = buildMessages({
    systemPrompt: scenario.systemPrompt,
    queryText: runtime.queryText,
    retrievedContext: debug.selected,
  });

  let completion;
  try {
    completion = await chatClient.complete(prompt);
  } catch (error) {
    console.log(section(style, "Model Reply"));
    if (error instanceof OpenAICompatError) {
      console.log(style.warning(`Chat request failed: ${error.message}`));
      console.log("The retrieval part is still working. If the model is unloaded, load it in your local model service first.");
      return 1;
    }
    throw error;
  }

  if (!args.hideModelReasoning) {
    console.log(section(style, "Model Reasoning"));
    console.log(formatModelReasoning(style, completion));
  }

  console.log(section(style, "Model Reply"));
  console.log(formatModelReply(style, completion));
  return 0;
}

function parseArgs(argv) {
  const args = {
    demo: process.env.POC_DEMO || defaultDemoName(),
    userId: "",
    query: "",
    baseUrl: process.env.POC_OPENAI_BASE_URL || DEFAULT_CHAT_BASE_URL,
    apiKey: process.env.POC_OPENAI_API_KEY || "",
    embeddingBaseUrl: "",
    embeddingModel: DEFAULT_EMBEDDING_MODEL,
    chatModel: DEFAULT_CHAT_MODEL,
    loadChatModel: false,
    skipChat: false,
    candidateLimit: 6,
    plain: false,
    hideRetrievalReasoning: false,
    hideModelReasoning: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--demo":
        args.demo = readValue(argv, ++index, arg);
        break;
      case "--user-id":
        args.userId = readValue(argv, ++index, arg);
        break;
      case "--query":
        args.query = readValue(argv, ++index, arg);
        break;
      case "--base-url":
        args.baseUrl = readValue(argv, ++index, arg);
        break;
      case "--api-key":
        args.apiKey = readValue(argv, ++index, arg);
        break;
      case "--embedding-base-url":
        args.embeddingBaseUrl = readValue(argv, ++index, arg);
        break;
      case "--embedding-model":
        args.embeddingModel = readValue(argv, ++index, arg);
        break;
      case "--chat-model":
        args.chatModel = readValue(argv, ++index, arg);
        break;
      case "--candidate-limit":
        args.candidateLimit = Number(readValue(argv, ++index, arg));
        break;
      case "--load-chat-model":
        args.loadChatModel = true;
        break;
      case "--skip-chat":
        args.skipChat = true;
        break;
      case "--reset-store":
        break;
      case "--plain":
        args.plain = true;
        break;
      case "--hide-retrieval-reasoning":
        args.hideRetrievalReasoning = true;
        break;
      case "--hide-model-reasoning":
        args.hideModelReasoning = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!demoNames().includes(args.demo)) {
    throw new Error(`unknown demo "${args.demo}", available demos: ${demoNames().join(", ")}`);
  }
  if (!Number.isFinite(args.candidateLimit) || args.candidateLimit <= 0) {
    throw new Error("--candidate-limit must be a positive number");
  }
  return args;
}

function readValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`User-scoped Orama hybrid retrieval proof of concept

Usage:
  node demo.mjs [options]

Options:
  --demo <name>                  Demo scenario: ${demoNames().join(", ")}
  --user-id <id>                 Override scenario user id
  --query <text>                 Override scenario query
  --base-url <url>               OpenAI-compatible chat base URL
  --api-key <key>                OpenAI-compatible API key
  --embedding-base-url <url>     OpenAI-compatible embedding base URL
  --embedding-model <model>      Embedding model name
  --chat-model <model>           Chat model name
  --load-chat-model              Ask LM Studio to load the chat model first
  --skip-chat                    Only run retrieval
  --candidate-limit <number>     Number of debug candidates to print
  --plain                        Disable ANSI colors
  --hide-retrieval-reasoning     Hide retrieval debug output
  --hide-model-reasoning         Hide model reasoning output
`);
}

function section(style, title) {
  return style.title(`=== ${title} ===`);
}

function formatQueryBlock({
  scenario,
  userId,
  queryText,
  embeddingModel,
  embeddingBaseUrl,
  chatModel,
  chatBaseUrl,
}) {
  return [
    f("demo", `${scenario.name} (${scenario.title})`),
    f("description", scenario.description),
    f("user_id", userId),
    f("query", queryText),
    f("retrieval_store", "Orama in-memory hybrid index"),
    f("embedding_model", embeddingModel),
    f("embedding_base_url", embeddingBaseUrl),
    f("chat_model", chatModel),
    f("chat_base_url", chatBaseUrl),
  ].join("\n");
}

function formatSelectedItem(style, item) {
  return [
    style.selected(`[${item.candidateRank}] SELECTED ${item.sourceType} | ${item.chunkId}`),
    `  score=${item.finalScore.toFixed(3)}  text=${item.text}`,
    style.subtle(`  ${scoreBreakdown(item)}`),
    style.subtle(`  why=${reasonTags(item).join(", ")}`),
  ].join("\n");
}

function formatRetrievalReasoning(style, debug, candidateLimit) {
  const visibleCandidates = debug.candidates.slice(0, candidateLimit);
  const blocks = [
    style.subtle(`selected=${debug.selected.length} dropped=${debug.dropped.length} visible_candidates=${visibleCandidates.length}/${debug.candidates.length}`),
  ];
  for (const item of visibleCandidates) {
    const label = item.selected ? style.selected("SELECTED") : style.dropped("DROPPED");
    blocks.push([
      `${label} [${item.candidateRank}] ${item.sourceType} | ${item.chunkId}`,
      `  text=${item.text}`,
      style.subtle(`  ${scoreBreakdown(item)}`),
      style.subtle(`  why=${reasonTags(item).join(", ")}`),
    ].join("\n"));
  }
  const hiddenCount = debug.candidates.length - visibleCandidates.length;
  if (hiddenCount > 0) {
    blocks.push(style.subtle(`... ${hiddenCount} more candidates omitted`));
  }
  return blocks.join("\n\n");
}

function scoreBreakdown(item) {
  return [
    `final=${item.finalScore.toFixed(3)}`,
    `orama=${item.oramaScore.toFixed(3)}*${ORAMA_HYBRID_WEIGHT}`,
    `lexical=${item.lexicalScore.toFixed(3)}`,
    `recency=${item.recencyScore.toFixed(3)}*${RECENCY_WEIGHT}`,
    `source_bonus=${item.sourceBonus.toFixed(3)}`,
    item.dropReason ? `drop=${item.dropReason}` : null,
  ].filter(Boolean).join("  ");
}

function reasonTags(item) {
  const tags = [];
  if (item.sourceType === "summary") {
    tags.push(`summary_bonus=${SUMMARY_BONUS}`);
  }
  if (item.lexicalScore > 0) {
    tags.push("text-match");
  }
  if (item.oramaScore >= 0.75) {
    tags.push("strong-orama-hybrid");
  }
  if (item.recencyScore >= 0.75) {
    tags.push("recent");
  }
  if (item.dropReason) {
    tags.push(item.dropReason);
  }
  return tags.length > 0 ? tags : ["fallback-score"];
}

function buildMessages({ systemPrompt, queryText, retrievedContext }) {
  const contextText = retrievedContext.length > 0
    ? retrievedContext.map((item) => `- [${item.sourceType} | ${item.createdAt.toISOString()} | session=${item.sessionId}] ${item.text}`).join("\n")
    : "- 无召回上下文。";
  return [
    {
      role: "system",
      content: `${systemPrompt}\n\n<retrieved_context>\n${contextText}\n</retrieved_context>`,
    },
    {
      role: "user",
      content: queryText,
    },
  ];
}

function formatModelReasoning(style, completion) {
  const usageLine = formatUsageLine(completion);
  if (completion.reasoningContent) {
    const reasoning = indent(completion.reasoningContent.trim(), "  ");
    return usageLine ? `${style.subtle(usageLine)}\n${style.modelReasoning(reasoning)}` : style.modelReasoning(reasoning);
  }
  return usageLine
    ? `${style.subtle(usageLine)}\n${style.warning("  接口未返回 reasoning_content。")}`
    : style.warning("  接口未返回 reasoning_content。");
}

function formatModelReply(style, completion) {
  const usageLine = formatUsageLine(completion);
  const reply = style.answer(completion.content.trim());
  return usageLine ? `${style.subtle(usageLine)}\n${reply}` : reply;
}

function formatUsageLine(completion) {
  const parts = [
    maybeUsage("prompt", completion.promptTokens),
    maybeUsage("completion", completion.completionTokens),
    maybeUsage("total", completion.totalTokens),
    maybeUsage("reasoning", completion.reasoningTokens),
    completion.finishReason ? `finish=${completion.finishReason}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? `usage: ${parts.join("  ")}` : "";
}

function maybeUsage(name, value) {
  return Number.isInteger(value) ? `${name}=${value}` : null;
}

function indent(text, prefix) {
  return text.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function f(name, value) {
  return `${name}: ${value}`;
}

class AnsiStyle {
  constructor(enabled) {
    this.enabled = enabled;
  }

  wrap(text, ...codes) {
    if (!this.enabled || codes.length === 0) {
      return text;
    }
    return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
  }

  title(text) {
    return this.wrap(text, "1", "94");
  }

  selected(text) {
    return this.wrap(text, "1", "92");
  }

  dropped(text) {
    return this.wrap(text, "1", "93");
  }

  modelReasoning(text) {
    return this.wrap(text, "95");
  }

  answer(text) {
    return this.wrap(text, "96");
  }

  subtle(text) {
    return this.wrap(text, "90");
  }

  warning(text) {
    return this.wrap(text, "91");
  }
}

process.exitCode = await main();
