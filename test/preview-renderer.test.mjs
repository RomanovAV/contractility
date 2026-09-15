import assert from "node:assert/strict";
import test from "node:test";
import { createPreviewRenderer } from "../public/preview-renderer.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("slow previous page preparation never paints over the selected page", async () => {
  const renderer = createPreviewRenderer();
  const loadingFirst = deferred();
  const painted = [];
  const completed = [];
  const paint = (page) => {
    painted.push(page);
    return { promise: Promise.resolve(), cancel() {} };
  };
  const first = renderer.render(async () => {
    await loadingFirst.promise;
    return () => paint(1);
  }, () => completed.push(1));
  assert.equal(await renderer.render(async () => () => paint(2), () => completed.push(2)), true);
  loadingFirst.resolve();
  assert.equal(await first, false);
  assert.deepEqual(painted, [2]);
  assert.deepEqual(completed, [2]);
});

test("new preview waits for the old canvas render to stop and skips superseded requests", async () => {
  const renderer = createPreviewRenderer();
  const started = deferred();
  const stopped = deferred();
  let busy = false;
  let cancelled = false;
  const painted = [];
  const completed = [];
  const first = renderer.render(async () => () => {
    busy = true;
    started.resolve();
    return {
      promise: stopped.promise.finally(() => { busy = false; }),
      cancel() { cancelled = true; },
    };
  }, () => completed.push(1));
  await started.promise;
  const prepare = (page) => async () => () => {
    assert.equal(busy, false, "shared canvas must be released before rendering again");
    painted.push(page);
    return { promise: Promise.resolve(), cancel() {} };
  };
  const second = renderer.render(prepare(2), () => completed.push(2));
  const third = renderer.render(prepare(3), () => completed.push(3));
  assert.equal(cancelled, true);
  assert.deepEqual(painted, []);
  stopped.reject(Object.assign(new Error("cancelled"), { name: "RenderingCancelledException" }));
  assert.deepEqual(await Promise.all([first, second, third]), [false, false, true]);
  assert.deepEqual(painted, [3]);
  assert.deepEqual(completed, [3]);
});

test("reset invalidates a pending PDF load", async () => {
  const renderer = createPreviewRenderer();
  const loading = deferred();
  const pending = renderer.render(async () => {
    await loading.promise;
    return () => assert.fail("reset document must never paint");
  });
  renderer.cancel();
  loading.resolve();
  assert.equal(await pending, false);
});

test("current preview failures are reported and a subsequent preview can render", async () => {
  const renderer = createPreviewRenderer();
  await assert.rejects(renderer.render(async () => () => ({
    promise: Promise.reject(new Error("damaged PDF page")), cancel() {},
  })), /damaged PDF page/);
  assert.equal(await renderer.render(async () => () => ({
    promise: Promise.resolve(), cancel() {},
  })), true);
});
