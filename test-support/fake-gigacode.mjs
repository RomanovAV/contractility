#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const model = valueAfter("--model");
const prompt = valueAfter("-p");
const mode = process.env.FAKE_GIGACODE_MODE ?? "pass";

function emit(result) {
  process.stdout.write(`${JSON.stringify({
    type: "system",
    session_id: `fake-${model}`,
    model,
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "result",
    session_id: `fake-${model}`,
    model,
    result: JSON.stringify(result),
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })}\n`);
}

if (prompt.includes('Return exactly {"status":"ok"}')) {
  emit({ status: "ok" });
} else if (prompt.includes("reconstruct the current contract from signed OCR evidence")) {
  const task = JSON.parse(
    await readFile(path.join(process.cwd(), "reconstruction-task.json"), "utf8"),
  );
  await readFile(path.join(process.cwd(), task.paths.evidenceManifest), "utf8");
  const artifacts = path.join(process.cwd(), "artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    path.join(artifacts, "current-contract.md"),
    `${"# Действующая редакция\n\nПроверяемая тестовая редакция договора. ".repeat(8)}\n`,
  );
  emit({ status: "reconstruction-ready" });
} else if (prompt.includes("plan contract changes against the reconstructed current contract")) {
  const task = JSON.parse(
    await readFile(path.join(process.cwd(), "change-plan-task.json"), "utf8"),
  );
  await readFile(path.join(process.cwd(), task.paths.currentContract), "utf8");
  const artifacts = path.join(process.cwd(), "artifacts");
  await writeFile(
    path.join(artifacts, "change-register.json"),
    `${JSON.stringify({ changes: [] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(artifacts, "change-plan.json"),
    `${JSON.stringify({ operations: [] }, null, 2)}\n`,
  );
  emit({ status: "change-plan-ready" });
} else if (prompt.includes("apply the prepared change plan to the retained DOCX package")) {
  const task = JSON.parse(
    await readFile(path.join(process.cwd(), "application-task.json"), "utf8"),
  );
  await readFile(path.join(process.cwd(), task.paths.changePlan), "utf8");
  if (mode.includes("producer-cancel")) {
    process.stdout.write(`${JSON.stringify({
      type: "system",
      session_id: `fake-${model}`,
      model,
    })}\n`);
    process.stderr.write(
      "(node:85131) MaxListenersExceededWarning: Possible EventTarget memory leak detected. "
      + "11 abort listeners added to [AbortSignal]. MaxListeners is 10.\n"
      + "Operation cancelled.\n",
    );
    process.exitCode = 1;
  } else {
    emit({ status: "candidate-ready" });
  }
} else if (prompt.includes("independent read-only review")) {
  const taskName = prompt.match(/Review task: ([^\s]+)/)?.[1];
  const task = JSON.parse(await readFile(path.join(process.cwd(), taskName), "utf8"));
  await readFile(path.join(process.cwd(), task.paths.evidenceManifest), "utf8");
  if (mode.includes("slow-review") && model === "review-model-c") {
    await delay(1000);
  }
  if (mode === "fix-once") {
    const roundDirectory = process.cwd();
    const xml = await readFile(path.join(roundDirectory, "package/word/document.xml"), "utf8");
    if (!xml.includes("исправлено")) {
      emit({
        verdict: "changes-required",
        findings: [{
          severity: "major",
          category: "legal-delta",
          target: "word/document.xml paragraph 1",
          sourceDocumentId: "document-2",
          page: 1,
          clause: "1",
          evidence: "Изменение",
          observed: "Тестовое изменение ещё не отражено",
          impact: "Кандидат не учитывает подписанное изменение",
          proposedAction: "Добавить подтверждённое изменение",
          confidence: 0.99,
        }],
      });
    } else {
      emit({ verdict: "pass", findings: [] });
    }
  } else {
    emit({ verdict: "pass", findings: [] });
  }
} else if (prompt.includes("independent review synthesis")) {
  const roundDirectory = process.cwd();
  const task = JSON.parse(
    await readFile(path.join(roundDirectory, "synthesis-task.json"), "utf8"),
  );
  if (mode === "fix-once" && task.findingIds.length > 0) {
    const documentPath = path.join(roundDirectory, "package/word/document.xml");
    const xml = await readFile(documentPath, "utf8");
    await writeFile(
      documentPath,
      xml.replace("Тестовое дополнительное соглашение", "Тестовое дополнительное соглашение — исправлено"),
    );
    emit({
      status: "fixed",
      acceptedFindingIds: task.findingIds,
      rejectedFindingIds: [],
      unresolvedFindingIds: [],
      summary: "Подтверждённое замечание исправлено.",
    });
  } else {
    emit({
      status: "done",
      acceptedFindingIds: [],
      rejectedFindingIds: task.findingIds,
      unresolvedFindingIds: [],
      summary: "Все обязательные рецензенты подтвердили тестовый кандидат.",
    });
  }
} else {
  emit({ status: "unexpected-prompt" });
}
