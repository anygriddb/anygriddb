import { createContext, useContext, type ReactNode } from "react";

const ReadOnlyContext = createContext(false);

/**
 * A region someone reads and cannot change. Every control of the kit
 * inside it is off, unless it says that it only reads (`reads`): a
 * search, a filter, the next page of a list, an export. A control added
 * later is off without a word, so nothing offers a change that would be
 * refused.
 */
export function ReadOnly({
  when,
  children,
}: {
  when: boolean;
  children: ReactNode;
}) {
  return (
    <ReadOnlyContext.Provider value={when}>{children}</ReadOnlyContext.Provider>
  );
}

/** Whether a control is off because its region is only read. */
export function useReadOnly(reads?: boolean): boolean {
  return useContext(ReadOnlyContext) && reads !== true;
}

/** What a control adds to its element's props to live in such a region. */
export type Reads = {
  /** This control changes nothing: it stays on where its region is only read. */
  reads?: boolean;
};
