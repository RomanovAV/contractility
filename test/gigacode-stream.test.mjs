import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runGigacode } from "../src/target/gigacode.mjs";

test("GigaCode preserves split UTF-8 characters on stdout and stderr and retains raw transcripts", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "contractility-utf8-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const command = path.join(root, "split-stream.mjs");
  const transcriptDirectory = path.join(root, "transcripts");
  const resultText = "Договор 📄";
  const errorText = "Диагностика 📋";
  const stdout = `${JSON.stringify({ type: "result", model: "utf8-model", result: resultText })}\n`;
  await writeFile(command, `
    import { setTimeout as delay } from "node:timers/promises";
    async function splitWrite(stream, text) {
      for (const character of text) {
        const bytes = Buffer.from(character);
        for (const byte of bytes) {
          stream.write(Buffer.from([byte]));
          if (bytes.length > 1) await delay(15);
        }
      }
    }
    await Promise.all([
      splitWrite(process.stdout, ${JSON.stringify(stdout)}),
      splitWrite(process.stderr, ${JSON.stringify(errorText)}),
    ]);
  `);
  const result = await runGigacode({
    config: {
      command: process.execPath, commandArgs: [command],
      sessionTimeoutSeconds: 10, idleTimeoutSeconds: 5, retryCount: 0,
    },
    model: "utf8-model", prompt: "fixture", cwd: root, session: "utf8",
    transcriptDirectory,
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, resultText);
  assert.equal(result.stderr, errorText);
  const files = await readdir(transcriptDirectory);
  assert.deepEqual(await readFile(path.join(transcriptDirectory, files.find((name) => name.endsWith(".stdout.ndjson")))), Buffer.from(stdout));
  assert.deepEqual(await readFile(path.join(transcriptDirectory, files.find((name) => name.endsWith(".stderr.log")))), Buffer.from(errorText));
});
