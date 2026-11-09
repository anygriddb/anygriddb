/**
 * Prints the record panel alone: the page marks itself while the print
 * dialog is open, and the print style shows only the panel, unfolded.
 * The grid is not printed this way: it draws only the rows on screen.
 */
export function printRecord(
  win: Pick<Window, "print" | "addEventListener"> & {
    document: Pick<Document, "body">;
  },
): void {
  const body = win.document.body;
  body.dataset.printing = "record";
  win.addEventListener(
    "afterprint",
    () => {
      delete body.dataset.printing;
    },
    { once: true },
  );
  win.print();
}
