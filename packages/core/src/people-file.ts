/**
 * A file of people an administrator adds at once (ROADMAP #36): one line
 * each, with the bases they reach from the start. It is read here, where
 * the page and the server agree on it; what needs the database (an address
 * already taken, a base's name) is the server's to say.
 */
import { z } from "zod";
import { DelimitedReader, detectDelimiter } from "./csv";
import { AppError } from "./errors";
import { labelSchema } from "./names";
import type { Role } from "./rbac";

/** People one file may add. A longer file is refused, never cut short. */
export const PEOPLE_FILE_MAX = 200;
export const PEOPLE_FILE_MAX_BYTES = 256_000;
/** Bases one person reaches from the start, as when one person is added. */
const PEOPLE_FILE_MAX_BASES = 20;

/**
 * Why a line adds nobody. The first five are read off the file; the
 * others need the instance: an address an account has, a base no live
 * base answers to, a name several bases share, an address outside the
 * domains invitations are limited to.
 */
export type PeopleFileProblem =
  | "invalid_email"
  | "invalid_name"
  | "twice"
  | "invalid_bases"
  | "too_many_bases"
  | "account_exists"
  | "unknown_base"
  | "ambiguous_base"
  | "domain_not_allowed";

type PeopleFileLine = {
  /** As a spreadsheet numbers it: the header is line 1. */
  line: number;
  email: string;
  displayName: string;
  /** Each base as written, a name or an id, and the role on it. */
  bases: { base: string; role: Role }[];
  problem: PeopleFileProblem | null;
};

const EMAIL_HEADERS = new Set(["email", "e-mail"]);
const NAME_HEADERS = new Set(["name", "nom", "displayname", "display name"]);
const BASES_HEADERS = new Set(["bases"]);

const emailSchema = z.email().max(254);

function column(header: readonly string[], names: Set<string>): number {
  return header.findIndex((cell) => names.has(cell.trim().toLowerCase()));
}

/** A role as the file may write it: the product's word, or the French one. */
const ROLE_WORDS: Readonly<Record<string, Role>> = {
  owner: "owner",
  editor: "editor",
  commenter: "commenter",
  viewer: "viewer",
  propriétaire: "owner",
  proprietaire: "owner",
  éditeur: "editor",
  editeur: "editor",
  commentateur: "commenter",
  lecteur: "viewer",
};

/**
 * `Sales:editor; Stock:viewer`. The role is the word after the last
 * colon, so a base's name may hold one; a name that holds a semicolon or
 * a bar is written as the base's id instead.
 */
function readBases(cell: string): PeopleFileLine["bases"] | null {
  const bases: PeopleFileLine["bases"] = [];
  for (const part of cell.split(/[;|]/)) {
    const written = part.trim();
    if (!written) continue;
    const colon = written.lastIndexOf(":");
    const base = written.slice(0, Math.max(colon, 0)).trim();
    const role =
      ROLE_WORDS[
        written
          .slice(colon + 1)
          .trim()
          .toLowerCase()
      ];
    if (!base || !role) return null;
    bases.push({ base, role });
  }
  return bases;
}

/**
 * The people of a file. Its first line names the columns: `email` and
 * `name`, and `bases` when people get roles. Comma, semicolon, or tab
 * separated, as a spreadsheet saves it. A file that cannot be read, has
 * no such columns, or names more than `PEOPLE_FILE_MAX` people is
 * refused whole; a line that cannot add its person says why.
 */
export function readPeopleFile(text: string): PeopleFileLine[] {
  if (text.length === 0 || text.length > PEOPLE_FILE_MAX_BYTES) {
    throw new AppError("invalid_csv");
  }
  const reader = new DelimitedReader({
    delimiter: detectDelimiter(text),
    maxCell: 2_000,
    maxCells: 20,
  });
  // Numbered as a spreadsheet shows them, before blank lines are left out.
  const records = [...reader.push(text), ...reader.end()]
    .map((cells, index) => ({ cells, line: index + 1 }))
    .filter(({ cells }) => cells.some((cell) => cell.trim() !== ""));
  const [first, ...body] = records;
  if (!first) throw new AppError("invalid_csv");
  const header = first.cells;
  const emailAt = column(header, EMAIL_HEADERS);
  const nameAt = column(header, NAME_HEADERS);
  const basesAt = column(header, BASES_HEADERS);
  if (emailAt === -1 || nameAt === -1) {
    throw new AppError("people_file_columns");
  }
  if (body.length === 0) throw new AppError("invalid_csv");
  if (body.length > PEOPLE_FILE_MAX) {
    throw new AppError("people_file_too_long");
  }

  const seen = new Set<string>();
  return body.map(({ cells, line }): PeopleFileLine => {
    const email = (cells[emailAt] ?? "").trim().toLowerCase();
    const displayName = (cells[nameAt] ?? "").trim();
    const bases = basesAt === -1 ? [] : readBases(cells[basesAt] ?? "");
    let problem: PeopleFileProblem | null = null;
    if (!emailSchema.safeParse(email).success) problem = "invalid_email";
    else if (!labelSchema.safeParse(displayName).success) {
      problem = "invalid_name";
    } else if (seen.has(email)) problem = "twice";
    else if (bases === null) problem = "invalid_bases";
    else if (bases.length > PEOPLE_FILE_MAX_BASES) problem = "too_many_bases";
    seen.add(email);
    return {
      line,
      email,
      displayName,
      bases: bases ?? [],
      problem,
    };
  });
}

/** A file to start from: the three columns, and each way to name a base. */
export const PEOPLE_FILE_SAMPLE = [
  "email,name,bases",
  "ada@example.org,Ada Lovelace,Sales:editor; Stock:viewer",
  "grace@example.org,Grace Hopper,",
  "",
].join("\r\n");
