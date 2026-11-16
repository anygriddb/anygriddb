export type UndoEntry = {
  label: string;
  undo: () => Promise<void>;
  redo: () => Promise<void>;
  /**
   * Resolves once the change is saved: false when saving failed, which
   * leaves nothing to undo. Absent for a change already saved.
   */
  settled?: Promise<boolean>;
};

export type UndoSizes = { past: number; future: number };

/**
 * What a step throws when the person gave it up, by leaving unanswered a
 * question it asked: nothing failed, and the step stays where it was.
 */
export class StepGivenUp extends Error {
  constructor() {
    super("Step given up");
    this.name = "StepGivenUp";
  }
}

/**
 * Changes kept for this session, 100 deep. A change is kept as soon as it
 * is sent; undo waits for it to be saved and passes over one whose save
 * failed. Undo and redo run one after the other, in the order asked.
 *
 * A step whose undoing or redoing fails is dropped, so the steps before it
 * can still be undone: a row locked or deleted since refuses for good.
 * With `keepFailed`, it stays where it was, to be tried again: a
 * dashboard's steps are writes of its own, refused only for a moment.
 * A step given up (`StepGivenUp`) stays too, and answers as if there had
 * been nothing to undo.
 */
export class UndoStack {
  private past: UndoEntry[] = [];
  private future: UndoEntry[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly onChange: (sizes: UndoSizes) => void,
    private readonly options: { keepFailed?: boolean } = {},
  ) {}

  push = (entry: UndoEntry): void => {
    this.past.push(entry);
    if (this.past.length > 100) this.past.shift();
    this.future = [];
    this.changed();
  };

  undo = (): Promise<UndoEntry | undefined> =>
    this.run(async () => {
      for (;;) {
        const entry = this.past.pop();
        if (!entry) return undefined;
        if (entry.settled && !(await entry.settled)) continue;
        try {
          await entry.undo();
        } catch (cause) {
          const givenUp = cause instanceof StepGivenUp;
          if (givenUp || this.options.keepFailed) this.past.push(entry);
          if (givenUp) return undefined;
          throw cause;
        }
        this.future.push(entry);
        return entry;
      }
    });

  redo = (): Promise<UndoEntry | undefined> =>
    this.run(async () => {
      const entry = this.future.pop();
      if (!entry) return undefined;
      try {
        await entry.redo();
      } catch (cause) {
        const givenUp = cause instanceof StepGivenUp;
        if (givenUp || this.options.keepFailed) this.future.push(entry);
        if (givenUp) return undefined;
        throw cause;
      }
      this.past.push(entry);
      return entry;
    });

  private run<T>(step: () => Promise<T>): Promise<T> {
    const next = this.queue.then(step).finally(() => this.changed());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private changed(): void {
    this.onChange({ past: this.past.length, future: this.future.length });
  }
}
