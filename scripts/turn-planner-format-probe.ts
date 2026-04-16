import pino from "pino";
import { loadConfig } from "../src/config/config.ts";
import { LlmClient } from "../src/llm/llmClient.ts";
import {
  createDefaultTurnPlannerProbeCases,
  createDefaultTurnPlannerProbeToolsets,
  createTurnPlannerFormatProbeExecutor,
  renderTurnPlannerProbeReport,
  runTurnPlannerFormatProbe
} from "../src/app/generation/turnPlannerFormatProbe.ts";

interface CliOptions {
  help: boolean;
  listCases: boolean;
  modelRef: string;
  caseIds: string[];
  timeoutMs?: number;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const cases = createDefaultTurnPlannerProbeCases();
  if (options.listCases) {
    for (const probeCase of cases) {
      console.log(`${probeCase.id}\t${probeCase.title}`);
    }
    return;
  }

  const selectedCases = options.caseIds.length > 0
    ? cases.filter((item) => options.caseIds.includes(item.id))
    : cases;
  if (selectedCases.length === 0) {
    throw new Error(`No probe cases selected. Available cases: ${cases.map((item) => item.id).join(", ")}`);
  }

  const config = loadConfig(process.env);
  const client = new LlmClient(config, pino({ level: "warn" }));
  if (!client.isConfigured([options.modelRef])) {
    throw new Error(`Model ref is not configured for chat generation: ${options.modelRef}`);
  }

  const result = await runTurnPlannerFormatProbe({
    modelRef: [options.modelRef],
    availableToolsets: createDefaultTurnPlannerProbeToolsets(),
    cases: selectedCases,
    executePrompt: createTurnPlannerFormatProbeExecutor({
      client,
      ...(typeof options.timeoutMs === "number" ? { timeoutMs: options.timeoutMs } : {})
    })
  });

  console.log(renderTurnPlannerProbeReport(result));
  if (result.summary.failedCases > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    help: false,
    listCases: false,
    modelRef: "lms_qwen35_a3b",
    caseIds: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (arg === "--list-cases") {
      options.listCases = true;
      continue;
    }
    if (arg === "--model-ref") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--model-ref requires a value");
      }
      options.modelRef = value;
      index += 1;
      continue;
    }
    if (arg === "--case") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--case requires a value");
      }
      options.caseIds.push(value);
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--timeout-ms requires a value");
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`--timeout-ms must be a positive number, received: ${value}`);
      }
      options.timeoutMs = parsed;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function printHelp() {
  console.log([
    "Usage: npx tsx scripts/turn-planner-format-probe.ts [options]",
    "",
    "Options:",
    "  --model-ref <id>    Model ref to probe. Default: lms_qwen35_a3b",
    "  --case <id>         Run a single named case. Repeatable.",
    "  --list-cases        Print built-in probe cases and exit.",
    "  --timeout-ms <n>    Override request timeout in milliseconds.",
    "  --help, -h          Show this help."
  ].join("\n"));
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
