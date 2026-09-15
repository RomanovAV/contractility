export function createTextEditor({ input, editNote, currentResult, isLocked, onEdit }) {
  function refreshLock() {
    const result = currentResult();
    input.disabled = isLocked() || !result || Boolean(result.error);
  }

  input.addEventListener("input", () => {
    const result = currentResult();
    if (isLocked() || !result || result.error) return;
    result.text = input.value;
    result.manuallyEdited = true;
    editNote.hidden = false;
    onEdit();
  });

  return {
    refreshLock,
    show() {
      const result = currentResult();
      input.value = result?.text ?? "";
      editNote.hidden = !result?.manuallyEdited;
      refreshLock();
    },
  };
}
