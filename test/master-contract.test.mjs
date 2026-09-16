import assert from "node:assert/strict";
import test from "node:test";
import { createMasterContract, validateMasterContract } from "../public/master-contract.mjs";
import { buildFormationRequest, formationLaunchAvailability } from "../public/workflow-utils.mjs";
import { validateFormationRequest } from "../src/target/case-store.mjs";

function payload() {
  return {
    currentContract: "Действующая редакция договора с сохранением всех условий и сведений об источниках. ".repeat(3),
    signedDocuments: [{ id: "document-1", order: 1, role: "contract", complete: true,
      file: { name: "contract.pdf", sha256: "a".repeat(64) }, pages: [{ number: 1, text: "Договор №1 от 01.01.2025" }] }],
    reconstructionScope: { schemaVersion: "contractility.reconstruction-scope.v1",
      baseContract: { sourceDocumentId: "document-1", number: "1", date: "01.01.2025", page: 1, evidence: "Договор №1 от 01.01.2025" }, instruments: [] },
  };
}

async function approvedMaster() {
  const master = await createMasterContract(payload());
  master.approval = { approver: "Проверяющий", approvedAt: new Date().toISOString(), sha256: master.sha256 };
  return master;
}

test("portable master binds the complete text, source history and approval", async () => {
  const master = await approvedMaster();
  assert.deepEqual(await validateMasterContract(JSON.parse(JSON.stringify(master))), master);
  for (const edit of [
    (value) => { value.payload.currentContract += "Изменение"; },
    (value) => { value.payload.signedDocuments[0].pages[0].text += "Изменение OCR"; },
    (value) => { value.payload.reconstructionScope.baseContract.number = "2"; },
    (value) => { value.approval.sha256 = "0".repeat(64); },
    (value) => { value.approval = null; },
  ]) {
    const changed = structuredClone(master);
    edit(changed);
    await assert.rejects(validateMasterContract(changed));
  }
  const pending = await createMasterContract(payload());
  await assert.rejects(validateMasterContract(pending), /подтверждён/);
  await validateMasterContract(pending, { requireApproval: false });
});

test("master and agreement stages have independent requirements", async () => {
  const master = await approvedMaster();
  const masterRequest = buildFormationRequest({ workflowStage: "master", ocrResult: {
    schemaVersion: "contractility.ocr.v2", complete: true, documents: master.payload.signedDocuments,
  } });
  assert.equal(masterRequest.inputs.newAgreementEdition, undefined);
  assert.deepEqual(masterRequest.workflow.map((step) => step.action), ["reconstruct-current-contract", "apply-signed-amendments"]);
  validateFormationRequest(masterRequest);
  const agreement = buildFormationRequest({ masterContract: master, draftAgreement: { name: "draft.docx", sha256: "b".repeat(64), size: 123 } });
  assert.deepEqual(agreement.inputs.signedDocuments, []);
  assert.deepEqual(agreement.workflow.map((step) => step.action), ["extract-proposed-changes", "generate-final-agreement"]);
  validateFormationRequest(agreement);
  assert.throws(() => validateFormationRequest({ ...agreement, inputs: { ...agreement.inputs, masterContract: null } }), /мастер-договора/);
  assert.throws(() => validateFormationRequest({ ...agreement, inputs: { ...agreement.inputs, signedDocuments: master.payload.signedDocuments } }), /без нового комплекта/);
  const availability = { ocrComplete: false, masterReady: true, draftReady: true, targetReady: true };
  assert.equal(formationLaunchAvailability(availability).enabled, true);
  assert.equal(formationLaunchAvailability({ ...availability, masterReady: false, ocrComplete: true }).enabled, false);
  assert.equal(formationLaunchAvailability({ ...availability, draftReady: false }).enabled, false);
});
