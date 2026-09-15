// PDF.js permits only one active render task per canvas. Preparation may finish
// out of order, so touching the shared canvas is deferred until startRender().
export function createPreviewRenderer() {
  let revision = 0;
  let activeTask = null;

  return {
    cancel() {
      revision += 1;
      activeTask?.cancel();
    },
    async render(prepare, onComplete = () => {}) {
      const request = ++revision;
      const previousTask = activeTask;
      previousTask?.cancel();
      try {
        if (previousTask) await previousTask.promise.catch(() => {});
        if (request !== revision) return false;
        const startRender = await prepare();
        if (request !== revision) return false;
        const task = startRender();
        activeTask = task;
        try {
          await task.promise;
          if (request !== revision) return false;
          onComplete();
          return true;
        } finally {
          if (activeTask === task) activeTask = null;
        }
      } catch (error) {
        if (request !== revision) return false;
        throw error;
      }
    },
  };
}
