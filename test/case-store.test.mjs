import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareCase, verifyCase } from "../src/target/case-store.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "contractility-case-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const source = Buffer.from("%PDF-1.4 harmless fixture");
  const draft = Buffer.from("DOCX identity fixture");
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const sourcePath = path.join(root, "source.pdf");
  const draftPath = path.join(root, "draft.docx");
  const requestPath = path.join(root, "request.json");
  const request = {
    schemaVersion: "contractility.formation-request.v1",
    inputs: {
      signedDocuments: [{
        id: "document-1", role: "contract", order: 1, complete: true,
        file: { name: "source.pdf", sha256: hash(source) },
        pages: [{ number: 1, text: "Договор" }],
      }],
      newAgreementEdition: { file: { name: "draft.docx", size: draft.length, sha256: hash(draft) } },
    },
    rules: { requireHumanApprovalBeforeFinalization: true },
  };
  await writeFile(sourcePath, source);
  await writeFile(draftPath, draft);
  return {
    root, request,
    async prepare() {
      await writeFile(requestPath, JSON.stringify(request));
      return prepareCase({
        requestPath, draftPath, outputRoot: path.join(root, "cases"),
        sources: { [request.inputs.signedDocuments[0].id]: sourcePath },
      });
    },
  };
}

test("case preparation rejects unsafe document IDs before creating output files", async (context) => {
  const { root, request, prepare } = await fixture(context);
  const sentinel = path.join(root, "escaped.pdf");
  await writeFile(sentinel, "existing document");
  for (const id of ["../../../escaped", "..\\..\\escaped", "/absolute", "C:\\escaped", ".", "..", "a/b", "a%2fb", "", 42, ["document-1"], "a".repeat(82)]) {
    request.inputs.signedDocuments[0].id = id;
    await assert.rejects(prepare(), /идентификатор документа/, String(id));
    assert.equal(await readFile(sentinel, "utf8"), "existing document");
    assert.equal((await readdir(root)).includes("cases"), false);
  }
});

test("case verification rejects manifest paths outside its directory", async (context) => {
  const { prepare } = await fixture(context);
  const prepared = await prepare();
  await verifyCase(prepared.caseDirectory);
  const manifestPath = path.join(prepared.caseDirectory, "case-manifest.json");
  for (const field of ["formationRequest", "signedDocuments", "newAgreementEdition"]) {
    const manifest = structuredClone(prepared.manifest);
    const entry = field === "signedDocuments" ? manifest.signedDocuments[0] : manifest[field];
    entry.path = "../../escaped.pdf";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyCase(prepared.caseDirectory), /Недопустимый относительный путь/);
  }
  const manifest = structuredClone(prepared.manifest);
  manifest.signedDocuments[0].id = "../../escaped";
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyCase(prepared.caseDirectory), /идентификатор документа/);
});
