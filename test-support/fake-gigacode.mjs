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
  const evidenceManifest = JSON.parse(
    await readFile(path.join(process.cwd(), task.paths.evidenceManifest), "utf8"),
  );
  const artifacts = path.join(process.cwd(), "artifacts");
  await mkdir(artifacts, { recursive: true });
  const baseDocument = evidenceManifest.documents.find(
    (document) => document.role === "contract",
  );
  const mixedBundle = mode.includes("mixed-contract-bundle");
  const scope = {
    schemaVersion: "contractility.reconstruction-scope.v1",
    baseContract: {
      sourceDocumentId: baseDocument.id,
      number: mixedBundle ? "32-01/10" : "TEST-1",
      date: mixedBundle ? "01.12.2011" : "01.01.2020",
      page: 1,
      evidence: mixedBundle
        ? "Договор №32-01/10 от 01.12.2011"
        : "Договор №TEST-1 от 01.01.2020",
    },
    instruments: evidenceManifest.documents
      .filter((document) => document.role === "additional-agreement")
      .flatMap((document) => {
        if (mixedBundle && document.id === "document-3") {
          return [
            {
              sourceDocumentId: document.id,
              pages: [1],
              agreementNumber: "10",
              agreementDate: "01.02.2024",
              referencedContractNumber: "38-ИЭ-РБ",
              referencedContractDate: "24.11.2020",
              decision: "excluded",
              reason: "Соглашение ссылается на другой базовый договор.",
            },
            {
              sourceDocumentId: document.id,
              pages: [2],
              agreementNumber: "8",
              agreementDate: "15.02.2024",
              referencedContractNumber: "32-01/10",
              referencedContractDate: "01.12.2011",
              decision: "included",
              reason: "Номер и дата базового договора совпадают.",
            },
            {
              sourceDocumentId: document.id,
              pages: [3],
              agreementNumber: "2",
              agreementDate: "01.03.2024",
              referencedContractNumber: "38-РБ-4216-2023",
              referencedContractDate: "30.05.2023",
              decision: "excluded",
              reason: "Соглашение ссылается на другой базовый договор.",
            },
          ];
        }
        return [{
          sourceDocumentId: document.id,
          pages: [1],
          agreementNumber: mixedBundle ? "6" : `TEST-${document.order}`,
          agreementDate: mixedBundle ? "01.01.2024" : "02.01.2020",
          referencedContractNumber: mixedBundle ? "32-01/10" : "TEST-1",
          referencedContractDate: mixedBundle ? "01.12.2011" : "01.01.2020",
          decision: "included",
          reason: "Номер и дата базового договора совпадают.",
        }];
      }),
  };
  await writeFile(
    path.join(artifacts, "reconstruction-scope.json"),
    `${JSON.stringify(scope, null, 2)}\n`,
  );
  await writeFile(
    path.join(artifacts, "current-contract.md"),
    mixedBundle
      ? [
        "# Действующая редакция",
        "",
        "Договор №32-01/10 от 01.12.2011.",
        "Пункт 5.1: Visa/Mastercard — 1.90%; SberPayQR — 1.60%; "
          + "SberPay FaceScan — 1.90%.",
        "Пункт 5.1.1 удалён соглашением №8.",
        "Соглашения №10 и №2 исключены как относящиеся к другим договорам.",
        "",
      ].join("\n")
      : `${"# Действующая редакция\n\nПроверяемая тестовая редакция договора. ".repeat(8)}\n`,
  );
  if (
    mixedBundle
    && (
      task.policy?.bundledDocumentPolicy
        !== "classify-each-contained-legal-instrument"
      || task.policy?.outOfScopeInstrumentPolicy !== "exclude-and-record"
      || task.policy?.fullClauseReplacementPolicy
        !== "supersede-entire-prior-clause-body-including-omitted-tiers-and-exceptions"
    )
  ) {
    emit({ status: "blocked", reason: "Missing mixed-contract scope policy." });
  } else {
    emit({ status: "reconstruction-ready" });
  }
} else if (prompt.includes("plan contract changes against the reconstructed current contract")) {
  const task = JSON.parse(
    await readFile(path.join(process.cwd(), "change-plan-task.json"), "utf8"),
  );
  await readFile(path.join(process.cwd(), task.paths.currentContract), "utf8");
  await readFile(path.join(process.cwd(), task.paths.reconstructionScope), "utf8");
  const artifacts = path.join(process.cwd(), "artifacts");
  const malformedPlan = mode.includes("malformed-plan")
    && !prompt.includes("Recovery after invalid JSON artifacts");
  await writeFile(
    path.join(artifacts, "change-register.json"),
    malformedPlan
      ? `{"changes":[{"evidence":"ПАО "ВымпелКом""}]}\n`
      : `${JSON.stringify({ changes: [] }, null, 2)}\n`,
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
  await readFile(path.join(process.cwd(), task.paths.reconstructionScope), "utf8");
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
  await readFile(path.join(process.cwd(), task.paths.reconstructionScope), "utf8");
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
  await readFile(path.join(roundDirectory, task.paths.reconstructionScope), "utf8");
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
