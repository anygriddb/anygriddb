import type { TRPCLink } from "@trpc/client";
import type { AnyRouter } from "@trpc/server";
import { observable, type Unsubscribable } from "@trpc/server/observable";
import { reasonOf } from "./errors";

/**
 * The proof Administration asks for before a change (ROADMAP #28): the
 * server decides which changes ask, and answers `step_up_required`. The
 * page then asks the person once, and the change is sent again: a screen
 * needs no word about it, and a change added later is covered.
 */
type Asker = () => Promise<boolean>;

let asker: Asker | null = null;
let asking: Promise<boolean> | null = null;

/** Who asks the person for the proof: the dialog of the page shown. */
export function setProofAsker(next: Asker | null): void {
  asker = next;
}

/** Asks once, even when several changes were refused together. */
function askProof(): Promise<boolean> {
  if (!asker) return Promise.resolve(false);
  asking ??= asker().finally(() => {
    asking = null;
  });
  return asking;
}

/**
 * Sends a change again, once, after the person gave the proof it was
 * refused for. Without anyone to ask, or when the person gives up, the
 * refusal goes on to the caller as it came.
 */
export function proofLink<Router extends AnyRouter>(): TRPCLink<Router> {
  return () =>
    ({ op, next }) =>
      observable((observer) => {
        let current: Unsubscribable | undefined;
        let asked = false;
        const send = () => {
          current = next(op).subscribe({
            next: (value) => observer.next(value),
            complete: () => observer.complete(),
            error: (error) => {
              const refused =
                op.type === "mutation" &&
                !asked &&
                reasonOf(error).code === "step_up_required";
              if (!refused) {
                observer.error(error);
                return;
              }
              asked = true;
              void askProof().then((proved) => {
                if (proved) send();
                else observer.error(error);
              });
            },
          });
        };
        send();
        return () => current?.unsubscribe();
      });
}
