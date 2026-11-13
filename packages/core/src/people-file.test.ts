import { describe, expect, it } from "vitest";
import { AppError } from "./errors";
import {
  PEOPLE_FILE_MAX,
  PEOPLE_FILE_SAMPLE,
  readPeopleFile,
} from "./people-file";

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : "thrown";
  }
}

describe("a file of people", () => {
  it("reads each person, and the bases they reach with their role", () => {
    expect(
      readPeopleFile(
        [
          "Email,Name,Bases",
          "Ada@Example.org,Ada Lovelace,Sales:editor; Stock:viewer",
          "grace@example.org,Grace Hopper,",
          'alan@example.org,Alan Turing,"Plans: 2027:owner|0b6f0c1e-6d5c-4f0e-9c59-6b1d2f3a4b5c:commenter"',
        ].join("\r\n"),
      ),
    ).toEqual([
      {
        line: 2,
        email: "ada@example.org",
        displayName: "Ada Lovelace",
        bases: [
          { base: "Sales", role: "editor" },
          { base: "Stock", role: "viewer" },
        ],
        problem: null,
      },
      {
        line: 3,
        email: "grace@example.org",
        displayName: "Grace Hopper",
        bases: [],
        problem: null,
      },
      {
        line: 4,
        email: "alan@example.org",
        displayName: "Alan Turing",
        bases: [
          { base: "Plans: 2027", role: "owner" },
          { base: "0b6f0c1e-6d5c-4f0e-9c59-6b1d2f3a4b5c", role: "commenter" },
        ],
        problem: null,
      },
    ]);
  });

  it("reads a file a spreadsheet saved with semicolons, columns in any order, blank lines left out", () => {
    expect(
      readPeopleFile(
        '\ufeffnom;e-mail;bases\n;;\nAda;ada@example.org;"Sales:Éditeur;Stock:lecteur"\n',
      ),
    ).toEqual([
      {
        line: 3,
        email: "ada@example.org",
        displayName: "Ada",
        bases: [
          { base: "Sales", role: "editor" },
          { base: "Stock", role: "viewer" },
        ],
        problem: null,
      },
    ]);
  });

  it("offers a sample that reads without a problem", () => {
    const lines = readPeopleFile(PEOPLE_FILE_SAMPLE);
    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.problem === null)).toBe(true);
  });

  it("says why a line adds nobody, and keeps reading", () => {
    const lines = readPeopleFile(
      [
        "email,name,bases",
        "not an address,Ada,",
        "ada@example.org,,",
        "grace@example.org,Grace,Sales",
        "alan@example.org,Alan,Sales:admin",
        "grace@example.org,Grace again,",
        "edsger@example.org,Edsger,Sales:viewer",
      ].join("\n"),
    );
    expect(lines.map((line) => line.problem)).toEqual([
      "invalid_email",
      "invalid_name",
      "invalid_bases",
      "invalid_bases",
      "twice",
      null,
    ]);
  });

  it("refuses a file without its columns, an empty one, and one too long", () => {
    expect(code(() => readPeopleFile(""))).toBe("invalid_csv");
    expect(code(() => readPeopleFile("email,name\n"))).toBe("invalid_csv");
    expect(code(() => readPeopleFile("address,name\na@example.org,A"))).toBe(
      "people_file_columns",
    );
    const people = Array.from(
      { length: PEOPLE_FILE_MAX + 1 },
      (_, index) => `p${String(index)}@example.org,Person ${String(index)}`,
    );
    expect(
      code(() => readPeopleFile(["email,name", ...people].join("\n"))),
    ).toBe("people_file_too_long");
    expect(
      readPeopleFile(["email,name", ...people.slice(1)].join("\n")),
    ).toHaveLength(PEOPLE_FILE_MAX);
  });
});
