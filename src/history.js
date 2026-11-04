// history.js
// Undo / redo. It does not know what is being edited: it just stores
// "snapshots" (copies of the state) and hands them back in order.
//
//   before editing:   history.record(snapshotOfTheOldState)
//   undo:             const old = history.undo(snapshotOfTheCurrentState)
//                     if (old) putStateBack(old)

export function createHistory(limit = 100) {
  const undoStack = [];
  const redoStack = [];

  return {
    /** Save the state as it was BEFORE an edit. Clears the redo list. */
    record(snapshot) {
      undoStack.push(snapshot);
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
    },

    /** Returns the state to go back to (or null if there is nothing to undo). */
    undo(current) {
      if (undoStack.length === 0) return null;
      redoStack.push(current);
      return undoStack.pop();
    },

    /** Returns the state to go forward to (or null). */
    redo(current) {
      if (redoStack.length === 0) return null;
      undoStack.push(current);
      return redoStack.pop();
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    clear() {
      undoStack.length = 0;
      redoStack.length = 0;
    },
  };
}
