import assert from "node:assert/strict";
import test from "node:test";
import { createTextEditor } from "../public/text-editor.mjs";

test("OCR edits are blocked throughout formation and resume when inputs unlock", () => {
  const input = new EventTarget();
  const editNote = {};
  const pages = [{ text: "Договор", manuallyEdited: false }, { text: "Соглашение" }];
  let selectedPage = 0;
  let jobId = null;
  let edits = 0;
  const editor = createTextEditor({
    input, editNote,
    currentResult: () => pages[selectedPage],
    isLocked: () => Boolean(jobId),
    onEdit: () => { edits += 1; },
  });
  editor.show();
  assert.equal(input.disabled, false);
  input.value = "Договор с правкой";
  input.dispatchEvent(new Event("input"));
  assert.equal(pages[0].text, "Договор с правкой");
  assert.equal(editNote.hidden, false);

  for (const activeId of ["preparing", "job-running", "job-awaiting-approval"]) {
    jobId = activeId;
    editor.refreshLock();
    assert.equal(input.disabled, true);
    input.value = "Запоздавшая правка";
    input.dispatchEvent(new Event("input"));
    assert.equal(pages[0].text, "Договор с правкой");
    selectedPage = 1;
    editor.show();
    assert.equal(input.disabled, true, "switching pages must preserve the lock");
    assert.equal(input.value, "Соглашение");
    input.value = "Ещё одна правка";
    input.dispatchEvent(new Event("input"));
    assert.equal(pages[1].text, "Соглашение");
    selectedPage = 0;
  }
  assert.equal(edits, 1);
  jobId = null;
  editor.show();
  assert.equal(input.disabled, false);
  input.value = "Новая версия";
  input.dispatchEvent(new Event("input"));
  assert.equal(pages[0].text, "Новая версия");
  assert.equal(edits, 2);
});

test("unavailable and failed OCR pages cannot be edited", () => {
  const input = new EventTarget();
  let result;
  const editor = createTextEditor({
    input, editNote: {}, currentResult: () => result, isLocked: () => false,
    onEdit: () => assert.fail("unavailable text must not change"),
  });
  for (const page of [undefined, { text: "", error: "OCR failed" }]) {
    result = page;
    editor.show();
    assert.equal(input.disabled, true);
    input.value = "Edited";
    input.dispatchEvent(new Event("input"));
    if (result) assert.equal(result.text, "");
  }
});
