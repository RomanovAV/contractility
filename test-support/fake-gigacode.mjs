#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const model = valueAfter("--model");
const prompt = valueAfter("-p");
const mode = process.env.FAKE_GIGACODE_MODE ?? "pass";

async function latestRoundDirectory() {
  const roundsRoot = path.join(process.cwd(), "rounds");
  const rounds = (await readdir(roundsRoot)).filter((name) => /^\d+$/.test(name)).sort();
  return path.join(roundsRoot, rounds.at(-1));
}

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
} else if (prompt.includes("produce the first candidate")) {
  const artifacts = path.join(process.cwd(), "rounds/01/artifacts");
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    path.join(artifacts, "current-contract.md"),
    `${"# Действующая редакция\n\nПроверяемая тестовая редакция договора. ".repeat(8)}\n`,
  );
  await writeFile(
    path.join(artifacts, "change-register.json"),
    `${JSON.stringify({ changes: [] }, null, 2)}\n`,
  );
  emit({ status: "candidate-ready" });
} else if (prompt.includes("independent read-only review")) {
  if (mode === "fix-once") {
    const roundDirectory = await latestRoundDirectory();
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
  const roundDirectory = await latestRoundDirectory();
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
