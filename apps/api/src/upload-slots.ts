/**
 * Uploads read at once by one process: an attachment, a file to import,
 * a base snapshot. Each is written to local disk as it arrives; past the
 * ceiling, one more is refused at once rather than queued, so a burst of
 * large files cannot fill the disk or hold every request open.
 */
export type UploadSlots = {
  /** A slot, or undefined when every slot is taken; give it back once. */
  take(): (() => void) | undefined;
  /** Slots taken now. */
  readonly busy: number;
};

export function uploadSlots(ceiling: number): UploadSlots {
  let busy = 0;
  return {
    take() {
      if (busy >= ceiling) return undefined;
      busy += 1;
      let given = false;
      return () => {
        if (given) return;
        given = true;
        busy -= 1;
      };
    },
    get busy() {
      return busy;
    },
  };
}
