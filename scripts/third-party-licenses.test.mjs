import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  licenseTexts,
  notices,
  outputFolder,
} from "./third-party-licenses.mjs";

describe("outputFolder", () => {
  const root = join(tmpdir(), "repository");

  it("takes a folder inside the repository", () => {
    assert.equal(
      outputFolder(root, join(root, "apps/web/public")),
      join(root, "apps/web/public"),
    );
    assert.equal(
      outputFolder(root, join(root, "..notes")),
      join(root, "..notes"),
    );
  });

  it("refuses the repository itself and anything outside it", () => {
    assert.equal(outputFolder(root, root), null);
    assert.equal(outputFolder(root, join(root, "..")), null);
    assert.equal(outputFolder(root, join(root, "../elsewhere")), null);
    assert.equal(outputFolder(root, "/etc"), null);
  });
});

describe("licenseTexts", () => {
  it("reads a package's license and notice files, and nothing else", () => {
    const folder = mkdtempSync(join(tmpdir(), "licenses-"));
    try {
      writeFileSync(join(folder, "LICENSE.md"), "MIT text\n");
      writeFileSync(join(folder, "NOTICE"), "A notice\n");
      writeFileSync(join(folder, "index.js"), "export {};\n");
      writeFileSync(join(folder, "licenses.json"), "{}\n");
      assert.deepEqual(licenseTexts(folder), ["MIT text", "A notice"]);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("gives nothing for a folder that is not there", () => {
    assert.deepEqual(licenseTexts("/nowhere/at/all"), []);
  });
});

describe("notices", () => {
  const listed = {
    MIT: [
      { name: "beta", versions: ["2.0.0"], paths: ["/b"], author: "B" },
      { name: "alpha", versions: ["1.0.0"], paths: ["/a"] },
    ],
    "Apache-2.0": [
      {
        name: "gamma",
        versions: ["3.1.0"],
        paths: ["/c"],
        homepage: "https://gamma.example",
      },
      { name: "delta", versions: ["0.1.0"], paths: ["/d"] },
    ],
  };
  const texts = {
    "/a": ["Text A"],
    "/b": ["Text B"],
    "/c": ["Apache"],
    "/d": [],
  };
  const text = notices(listed, (folder) => texts[folder]);

  it("names each package once, in order, with its license", () => {
    const titles = text
      .split("\n")
      .filter((line) => /^(alpha|beta|gamma|delta) /.test(line));
    assert.deepEqual(titles, [
      "alpha 1.0.0",
      "beta 2.0.0",
      "delta 0.1.0",
      "gamma 3.1.0",
    ]);
    assert.match(text, /beta 2\.0\.0\nLicense: MIT\nAuthor: B\n/);
    assert.match(text, /Homepage: https:\/\/gamma\.example/);
    assert.match(text, /^4 packages\.$/m);
  });

  it("says so when a package carries no license file", () => {
    assert.match(
      text,
      /delta 0\.1\.0\nLicense: Apache-2\.0\n=+\n\nThe package carries no license file/,
    );
  });

  it("prints a text once and names it after", () => {
    const twice = notices(
      {
        MIT: [
          { name: "one", versions: ["1.0.0"], paths: ["/x"] },
          { name: "two", versions: ["1.0.0"], paths: ["/y"] },
        ],
      },
      () => ["The same text"],
    );
    assert.equal(twice.split("The same text").length - 1, 1);
    assert.match(twice, /Same text as one 1\.0\.0, above\./);
  });
});
