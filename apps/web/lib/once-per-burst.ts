/**
 * Runs `run` once for a burst of calls: `delay` after the first of them,
 * whatever came meanwhile, and again for the calls that come after it
 * ran. A page that reads again what others changed reads once per burst,
 * not once per change.
 */
export function oncePerBurst(
  run: () => void,
  delay: number,
): { soon: () => void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    soon() {
      timer ??= setTimeout(() => {
        timer = undefined;
        run();
      }, delay);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
