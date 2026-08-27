#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const args = process.argv.slice(2);
const valueAfter = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
};
const model = valueAfter("--model") || "fake-default-model";
const prompt = valueAfter("-p");
const mode = process.env.FAKE_GIGACODE_MODE ?? "pass";
const humanRequiredMarker = "[ТРЕБУЕТСЯ ЗАПОЛНЕНИЕ ЧЕЛОВЕКОМ]";

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

function emitText(result) {
  process.stdout.write(`${JSON.stringify({
    type: "system",
    session_id: `fake-${model}`,
    model,
  })}\n`);
  process.stdout.write(`${JSON.stringify({
    type: "result",
    session_id: `fake-${model}`,
    model,
    result,
    usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
  })}\n`);
}

if (model === "missing-model") {
  emitText("[API Error: 404 Model not found]");
} else if (prompt.includes("Simulate one successful-exit transport failure")) {
  const marker = path.join(process.cwd(), ".fake-transport-retried");
  try {
    await readFile(marker, "utf8");
    emit({ status: "ok" });
  } catch {
    await writeFile(marker, "retried\n");
    emitText("[API Error: terminated (cause: other side closed)]");
  }
} else if (prompt.includes("Simulate model fallback and one 400 termination")) {
  const marker = path.join(process.cwd(), ".fake-400-termination-retried");
  try {
    await readFile(marker, "utf8");
    emit({ status: "ok" });
  } catch {
    await writeFile(marker, "retried\n");
    emitText("[API Error: 400 terminated]");
  }
} else if (prompt.includes('Return exactly {"status":"ok"}')) {
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
  const unreadableBaseIdentity = mode.includes("unreadable-base-identity");
  const invalidReconstructionScope = mode.includes("invalid-reconstruction-scope")
    && !prompt.includes("Recovery after invalid reconstruct artifacts");
  const invalidReconstructionSourceId = mode.includes("invalid-reconstruction-source-id")
    && !prompt.includes("copy each sourceDocumentId verbatim");
  const scope = {
    schemaVersion: "contractility.reconstruction-scope.v1",
    baseContract: {
      sourceDocumentId: baseDocument.id,
      number: unreadableBaseIdentity
        ? humanRequiredMarker
        : mixedBundle ? "32-01/10" : "TEST-1",
      date: unreadableBaseIdentity
        ? humanRequiredMarker
        : mixedBundle ? "01.12.2011" : "01.01.2020",
      page: 1,
      evidence: unreadableBaseIdentity
        ? "OCR: #00), 2077 г."
        : mixedBundle
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
          sourceDocumentId: invalidReconstructionSourceId
            ? `${document.id}-instrument-1`
            : document.id,
          pages: [1],
          agreementNumber: mixedBundle ? "6" : `TEST-${document.order}`,
          agreementDate: mixedBundle ? "01.01.2024" : "02.01.2020",
          referencedContractNumber: invalidReconstructionScope
            ? "OTHER-1"
            : mixedBundle ? "32-01/10" : "TEST-1",
          referencedContractDate: mixedBundle ? "01.12.2011" : "01.01.2020",
          decision: unreadableBaseIdentity ? "unresolved" : "included",
          reason: unreadableBaseIdentity
            ? "Идентичность базового договора требует заполнения человеком."
            : "Номер и дата базового договора совпадают.",
        }];
      }),
  };
  await writeFile(
    path.join(artifacts, "reconstruction-scope.json"),
    `${JSON.stringify(scope, null, 2)}\n`,
  );
  await writeFile(
    path.join(artifacts, "current-contract.md"),
    unreadableBaseIdentity
      ? `${"# Действующая редакция\n\nНомер и дата: "
          + `${humanRequiredMarker}. Неподтверждённые инструменты не применены.\n\n`}`.repeat(4)
      : mixedBundle
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
  } else if (
    mode.includes("reconstruct-status-retry")
    && !prompt.includes("Structured-output retry after producer stage")
    && !prompt.includes("Recovery after unresolved model-fill values")
  ) {
    emitText("Реконструкция завершена, артефакты сохранены.");
  } else if (
    unreadableBaseIdentity
    && !prompt.includes("Recovery after unresolved model-fill values")
  ) {
    emit({
      status: "blocked",
      reason: "base-contract identity unreadable: OCR values #00) and 2077 г.",
    });
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
    && !prompt.includes("Recovery after invalid plan artifacts");
  const incompletePlan = mode.includes("incomplete-plan-artifacts")
    && (
      mode.includes("incomplete-plan-artifacts-always")
      || !prompt.includes("Recovery after invalid plan artifacts")
      || prompt.includes("attempt 1 of")
    );
  const unresolvedFields = mode.includes("unreadable-base-identity")
    ? [{
      target: "Реквизиты базового договора",
      reason: "Номер и дата не читаются в OCR.",
      sourceDocumentId: "document-1",
      page: 1,
      marker: humanRequiredMarker,
    }]
    : (
      mode.includes("missing-unresolved-marker")
      || mode.includes("wrong-unresolved-marker")
    )
    ? ["Поле шаблона 1", "Поле шаблона 2"].map((target) => ({
      target,
      reason: "Значение отсутствует в доказательствах.",
      sourceDocumentId: "document-1",
      page: 1,
      marker: mode.includes("wrong-unresolved-marker")
        ? "ТРЕБУЕТСЯ ЗАПОЛНЕНИЕ"
        : humanRequiredMarker,
    }))
    : [];
  await writeFile(
    path.join(artifacts, "change-register.json"),
    malformedPlan
      ? `{"changes":[{"evidence":"ПАО "ВымпелКом""}]}\n`
      : incompletePlan
      ? `${JSON.stringify({ changes: [] }, null, 2)}\n`
      : `${JSON.stringify({ changes: [], unresolvedFields }, null, 2)}\n`,
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
  if (mode.includes("unreadable-base-identity")) {
    const documentPath = path.join(process.cwd(), "package/word/document.xml");
    const xml = await readFile(documentPath, "utf8");
    await writeFile(
      documentPath,
      xml.replace(
        "Тестовое дополнительное соглашение",
        `Тестовое дополнительное соглашение — ${humanRequiredMarker}`,
      ),
    );
  }
  if (
    (
      mode.includes("wrong-unresolved-marker")
      || (
        mode.includes("missing-unresolved-marker")
        && prompt.includes("Recovery after invalid apply artifacts")
      )
    )
  ) {
    const documentPath = path.join(process.cwd(), "package/word/document.xml");
    const xml = await readFile(documentPath, "utf8");
    const updated = xml.replace(
      "Тестовое дополнительное соглашение",
      `Тестовое дополнительное соглашение — ${humanRequiredMarker}; `
        + humanRequiredMarker,
    );
    await writeFile(
      documentPath,
      updated
        .replaceAll("<w:", "<ns0:")
        .replaceAll("</w:", "</ns0:")
        .replace("xmlns:w=", "xmlns:ns0="),
    );
  }
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
} else if (prompt.includes("formatting-only recovery for a review report")) {
  emit({ verdict: "pass", findings: [] });
} else if (prompt.includes("independent read-only review")) {
  const taskName = prompt.match(/Review task: ([^\s]+)/)?.[1];
  const task = JSON.parse(await readFile(path.join(process.cwd(), taskName), "utf8"));
  await readFile(path.join(process.cwd(), task.paths.evidenceManifest), "utf8");
  await readFile(path.join(process.cwd(), task.paths.reconstructionScope), "utf8");
  if (mode.includes("reviewer-mutates-workspace") && model === "review-model-a") {
    const documentPath = path.join(process.cwd(), "package/word/document.xml");
    const xml = await readFile(documentPath, "utf8");
    await writeFile(
      documentPath,
      xml.replace(
        "Тестовое дополнительное соглашение",
        "Тестовое дополнительное соглашение — недопустимая правка reviewer-а",
      ),
    );
  }
  if (mode.includes("slow-review") && model === "review-model-c") {
    await delay(1000);
  }
  if (
    mode.includes("review-format-retry")
    && !prompt.includes("Structured-output retry.")
    && model === "review-model-a"
  ) {
    emitText("I've verified the candidate and saved the report.");
  } else if (
    mode.includes("review-format-retry")
    && !prompt.includes("Structured-output retry.")
    && model === "review-model-b"
  ) {
    emitText("JSON сохранён в отчёт reviewer-а.");
  } else if (mode.includes("highlight-as-track-changes") && model === "review-model-a") {
    emit({
      verdict: "changes-required",
      findings: [{
        severity: "minor",
        category: "document-fidelity",
        target: "package/word/document.xml paragraph 1",
        sourceDocumentId: "candidate.docx",
        page: null,
        clause: "1",
        evidence: "w:highlight w:val=\"green\"",
        observed: "The text carries a green highlight (track-changes artifact).",
        impact: "Visible formatting residual.",
        proposedAction: "Remove w:highlight.",
        confidence: 0.99,
      }],
    });
  } else if (mode.includes("fix-once")) {
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
} else if (prompt.includes("read-only recovery after unstructured review synthesis")) {
  const trustedIdsMatch = prompt.match(
    /<TRUSTED_FINDING_IDS>\s*(\[[\s\S]*?\])\s*<\/TRUSTED_FINDING_IDS>/,
  );
  const findingIds = trustedIdsMatch ? JSON.parse(trustedIdsMatch[1]) : [];
  if (mode.includes("synthesis-format-always-invalid")) {
    emitText(`Классификация завершена для ${findingIds.join(", ")}, итог сохранён.`);
  } else {
    emit({
      status: "fixed",
      acceptedFindingIds: findingIds,
      rejectedFindingIds: [],
      unresolvedFindingIds: [],
      summary: "Read-only арбитр подтвердил, что исправление уже внесено.",
    });
  }
} else if (prompt.includes("Structured-output recovery after review synthesis")) {
  const trustedIdsMatch = prompt.match(
    /<TRUSTED_FINDING_IDS>\s*(\[[\s\S]*?\])\s*<\/TRUSTED_FINDING_IDS>/,
  );
  const findingIds = trustedIdsMatch ? JSON.parse(trustedIdsMatch[1]) : [];
  if (mode.includes("synthesis-writes-consensus")) {
    await writeFile(
      path.join(process.cwd(), "consensus.json"),
      `${JSON.stringify({ status: "unvalidated-model-file" })}\n`,
    );
  }
  if (mode.includes("synthesis-read-only-mutates-workspace")) {
    const documentPath = path.join(process.cwd(), "package/word/document.xml");
    const xml = await readFile(documentPath, "utf8");
    await writeFile(
      documentPath,
      xml.replace("исправлено", "исправлено — недопустимая правка read-only арбитра"),
    );
  }
  if (mode.includes("synthesis-format-always-invalid")) {
    emitText(`Классификация завершена для ${findingIds.join(", ")}, итог сохранён.`);
  } else {
    emit({
      status: "fixed",
      acceptedFindingIds: findingIds,
      rejectedFindingIds: [],
      unresolvedFindingIds: [],
      summary: "Подтверждённое замечание исправлено.",
    });
  }
} else if (prompt.includes("independent review synthesis")) {
  const roundDirectory = process.cwd();
  const task = JSON.parse(
    await readFile(path.join(roundDirectory, "synthesis-task.json"), "utf8"),
  );
  await readFile(path.join(roundDirectory, task.paths.reconstructionScope), "utf8");
  if (mode.includes("synthesis-writes-consensus")) {
    await writeFile(
      path.join(roundDirectory, "consensus.json"),
      `${JSON.stringify({ status: "unvalidated-model-file" })}\n`,
    );
  }
  if (mode.includes("synthesis-writes-candidate")) {
    await writeFile(path.join(roundDirectory, "candidate.docx"), "model-written-candidate");
  }
  if (mode.includes("synthesis-blocked") && task.findingIds.length > 0) {
    emit({
      status: "blocked",
      acceptedFindingIds: [],
      rejectedFindingIds: [],
      unresolvedFindingIds: task.findingIds,
      summary: "Тестовое замечание требует решения человека.",
    });
  } else if (mode.includes("fix-once") && task.findingIds.length > 0) {
    const documentPath = path.join(roundDirectory, "package/word/document.xml");
    let xml = await readFile(documentPath, "utf8");
    if (mode.includes("synthesis-invalid-artifact")) {
      const recovery = prompt.includes("Recovery after invalid synthesis artifacts");
      if (recovery && !mode.includes("synthesis-invalid-artifact-always")) {
        xml = xml.replace("<broken-synthesis-artifact>", "");
      } else if (!xml.includes("<broken-synthesis-artifact>")) {
        xml += "<broken-synthesis-artifact>";
      }
    }
    await writeFile(
      documentPath,
      xml.replace("Тестовое дополнительное соглашение", "Тестовое дополнительное соглашение — исправлено"),
    );
    if (
      mode.includes("synthesis-format-retry")
      || mode.includes("synthesis-format-always-invalid")
    ) {
      emitText(
        mode.includes("synthesis-missing-ids")
          ? "Все задачи выполнены, замечания исправлены в package/word/document.xml."
          : `Все задачи выполнены для ${task.findingIds.join(", ")}; `
            + "замечания исправлены в package/word/document.xml.",
      );
    } else {
      emit({
        status: "fixed",
        acceptedFindingIds: task.findingIds,
        rejectedFindingIds: [],
        unresolvedFindingIds: [],
        summary: "Подтверждённое замечание исправлено.",
      });
    }
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
