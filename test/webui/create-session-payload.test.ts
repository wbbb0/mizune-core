import assert from "node:assert/strict";
import { buildCreateSessionPayload } from "../../webui/src/components/sessions/createSessionPayload.ts";

async function runCase(name: string, fn: () => void | Promise<void>) {
  process.stdout.write(`- ${name} ... `);
  await fn();
  process.stdout.write("ok\n");
}

async function main() {
  await runCase("create session payload preserves manual title and mode", () => {
    assert.deepEqual(buildCreateSessionPayload({
      title: "  Warehouse infiltration  ",
      modeId: "scenario_host"
    }), {
      title: "Warehouse infiltration",
      modeId: "scenario_host"
    });
  });

  await runCase("create session payload omits blank title", () => {
    assert.deepEqual(buildCreateSessionPayload({
      title: "   ",
      modeId: "rp_assistant"
    }), {
      modeId: "rp_assistant"
    });
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
