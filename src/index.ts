import { createAppRuntime } from "./app/runtime/appRuntime.ts";

// Starts the app and attaches process-level shutdown hooks.
async function main() {
  const app = await createAppRuntime();
  let shuttingDown = false;

  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    await app.shutdown();
    process.exit(signal === "SIGINT" ? 130 : 0);
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });

  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exit(1);
});
