import { useCallback, useRef, useState } from "react";

export type UndoEntry = {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
};

/** Client-side undo stack for this table session, 100 entries deep. */
export function useUndo() {
  const past = useRef<UndoEntry[]>([]);
  const future = useRef<UndoEntry[]>([]);
  // What rendering needs from the stacks, kept in state so a change shows.
  const [sizes, setSizes] = useState({ past: 0, future: 0 });
  const measure = useCallback(() => {
    setSizes({ past: past.current.length, future: future.current.length });
  }, []);
  const push = useCallback(
    (entry: UndoEntry) => {
      past.current.push(entry);
      if (past.current.length > 100) past.current.shift();
      future.current = [];
      measure();
    },
    [measure],
  );
  const undo = useCallback(async (): Promise<UndoEntry | undefined> => {
    const entry = past.current.pop();
    if (!entry) return undefined;
    await entry.undo();
    future.current.push(entry);
    measure();
    return entry;
  }, [measure]);
  const redo = useCallback(async (): Promise<UndoEntry | undefined> => {
    const entry = future.current.pop();
    if (!entry) return undefined;
    await entry.redo();
    past.current.push(entry);
    measure();
    return entry;
  }, [measure]);
  return {
    push,
    undo,
    redo,
    canUndo: sizes.past > 0,
    canRedo: sizes.future > 0,
  };
}
