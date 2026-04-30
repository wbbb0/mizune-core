import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  detectTerminalInputPrompt,
  normalizeTerminalOutput,
  stripAnsi
} from "../../src/services/shell/inputPromptDetector.ts";

describe("terminal input prompt detector", () => {
  test("detects confirmation prompts", () => {
    const detected = detectTerminalInputPrompt("Install dependencies? [y/N] ");
    assert.equal(detected?.kind, "confirmation");
    assert.equal(detected?.confidence, "high");
  });

  test("detects password and passphrase prompts", () => {
    assert.equal(detectTerminalInputPrompt("Password: ")?.kind, "password");
    assert.equal(detectTerminalInputPrompt("Enter passphrase for key '/tmp/id': ")?.kind, "password");
  });

  test("detects selection prompts", () => {
    const detected = detectTerminalInputPrompt("? Select package manager\n  npm\n❯ pnpm\n  yarn");
    assert.equal(detected?.kind, "selection");
  });

  test("detects text input prompts conservatively", () => {
    const detected = detectTerminalInputPrompt("Enter branch name: ");
    assert.equal(detected?.kind, "text_input");
    assert.equal(detected?.confidence, "medium");
  });

  test("strips ansi sequences before detection", () => {
    const raw = "\u001b[32mProceed? [y/N]\u001b[0m ";
    assert.equal(stripAnsi(raw), "Proceed? [y/N] ");
    assert.equal(detectTerminalInputPrompt(raw)?.kind, "confirmation");
  });

  test("normalizes carriage-return progress output", () => {
    const normalized = normalizeTerminalOutput("Downloading 10%\rDownloading 90%\rProceed? [y/N] ");
    assert.equal(normalized, "Proceed? [y/N] ");
    assert.equal(detectTerminalInputPrompt(normalized)?.kind, "confirmation");
  });

  test("does not treat common logs as prompts", () => {
    assert.equal(detectTerminalInputPrompt("ERROR: failed to compile"), null);
    assert.equal(detectTerminalInputPrompt("error TS2322: Type 'string' is not assignable"), null);
    assert.equal(detectTerminalInputPrompt("    at main (/tmp/app.ts:12:3)"), null);
    assert.equal(detectTerminalInputPrompt("Open http://localhost:3000?debug=true"), null);
    assert.equal(detectTerminalInputPrompt("src/index.ts:42:13"), null);
  });

  test("rejects very long prompt-like lines", () => {
    const longLine = `${"x".repeat(301)}?`;
    assert.equal(detectTerminalInputPrompt(longLine), null);
  });
});
