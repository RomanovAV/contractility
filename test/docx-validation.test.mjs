import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { packDocx, validateExtractedPackage } from "../src/target/docx.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "contractility-xml-test-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "package");
  await mkdir(path.join(directory, "word"), { recursive: true });
  await mkdir(path.join(directory, "_rels"), { recursive: true });
  await writeFile(path.join(directory, "[Content_Types].xml"), '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
  await writeFile(path.join(directory, "_rels/.rels"), '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  await writeFile(path.join(directory, "word/document.xml"), '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body/></w:document>');
  return { root, directory };
}

test("DOCX validation rejects malformed XML before packaging", async (context) => {
  const { root, directory } = await fixture(context);
  for (const xml of [
    "<document>A & B</document>",
    "<document bad=oops/>",
    '<document a="1" a="2"/>',
    "<w:document/>",
    "<document/><extra/>",
    "<document>&unknown;</document>",
    "<document>&#0;</document>",
    "<document>\u0001</document>",
    "<document><p></document>",
    "<document><!-- bad -- comment --></document>",
    "<document>text]]></document>",
    "text without a root element",
    "",
  ]) {
    await writeFile(path.join(directory, "word/document.xml"), xml);
    await assert.rejects(packDocx(directory, path.join(root, "invalid.docx")), /XML-структура/, xml);
  }
});

test("DOCX validation accepts valid attributes, entities, comments and CDATA", async (context) => {
  const { directory } = await fixture(context);
  await writeFile(path.join(directory, "word/document.xml"), `<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <!-- a comment mentioning <fake> and <!DOCTYPE is ordinary text -->
  <w:body><w:p attr='a > b'><w:r><w:t>A &amp; B &#x414; &#1044;</w:t></w:r>
  <![CDATA[<not-a-tag> & text]]></w:p></w:body>
</w:document>`);
  await validateExtractedPackage(directory);
});

test("DOCX validation rejects DTDs and external entities", async (context) => {
  const { directory } = await fixture(context);
  for (const xml of [
    '<!DOCTYPE document SYSTEM "https://example.invalid/doc.dtd"><document/>',
    '<!DOCTYPE document [<!ENTITY x SYSTEM "file:///nonexistent">]><document>&x;</document>',
  ]) {
    await writeFile(path.join(directory, "word/document.xml"), xml);
    await assert.rejects(validateExtractedPackage(directory), /DTD\/ENTITY/);
  }
});

test("DOCX external relationship policy handles namespaces, quotes and entities", async (context) => {
  const { directory } = await fixture(context);
  const rels = path.join(directory, "_rels/.rels");
  const relationship = (type) => `<r:Relationships xmlns:r="http://schemas.openxmlformats.org/package/2006/relationships">
    <r:Relationship Id='rId1' TargetMode='&#69;xternal'
      Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}'
      Target='https://example.invalid/file'/>
  </r:Relationships>`;
  await writeFile(rels, relationship("attachedTemplate"));
  await assert.rejects(validateExtractedPackage(directory), /Запрещённая внешняя связь/);
  await writeFile(rels, relationship("hyperlink"));
  await validateExtractedPackage(directory);
});
