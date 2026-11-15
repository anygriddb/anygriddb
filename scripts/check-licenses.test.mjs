import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allowed, refusals } from "./check-licenses.mjs";

const packages = (...names) => names.map((name) => ({ name }));

describe("allowed", () => {
  it("takes an identifier of the list", () => {
    assert.equal(allowed("MIT"), true);
    assert.equal(allowed("LGPL-3.0-or-later"), true);
  });

  it("takes an OR by the side that is in the list, an AND by all of it", () => {
    assert.equal(allowed("(MIT OR GPL-3.0-or-later)"), true);
    assert.equal(allowed("(Apache-2.0 OR UPL-1.0)"), true);
    assert.equal(allowed("(MIT AND Zlib)"), true);
    assert.equal(allowed("(MIT AND SSPL-1.0)"), false);
    assert.equal(allowed("(SSPL-1.0 OR BUSL-1.1)"), false);
  });

  it("refuses what the OSI does not approve, or what names no license", () => {
    for (const expression of [
      "SSPL-1.0",
      "BUSL-1.1",
      "Elastic-2.0",
      "CC-BY-NC-4.0",
      "MIT/X11",
      "SEE LICENSE IN LICENSE.md",
      "Unknown",
      "",
    ]) {
      assert.equal(allowed(expression), false, expression);
    }
  });
});

describe("refusals", () => {
  it("says nothing of a tree whose every license is taken", () => {
    assert.deepEqual(
      refusals({
        MIT: packages("left", "right"),
        "(MIT OR GPL-3.0-or-later)": packages("either"),
        "CC-BY-4.0": packages("caniuse-lite"),
      }),
      [],
    );
  });

  it("names each package refused, once, and why", () => {
    assert.deepEqual(
      refusals({
        MIT: packages("left"),
        Unknown: packages("silent", "silent"),
        "BUSL-1.1": packages("source-available"),
      }),
      [
        "silent: states no license",
        "source-available: BUSL-1.1 is not a license the project takes",
      ],
    );
  });

  // exceljs once pulled unzipper 0.10 → binary → buffers (no license field).
  // The pnpm override keeps unzipper 0.12; this asserts the policy still
  // refuses that package if it ever returns under Unknown.
  it("refuses a package that states no license, as buffers once did", () => {
    assert.deepEqual(refusals({ Unknown: packages("buffers") }), [
      "buffers: states no license",
    ]);
  });

  it("keeps an exception to the license it was made for", () => {
    assert.deepEqual(refusals({ "CC-BY-4.0": packages("other-data") }), [
      "other-data: CC-BY-4.0 is not a license the project takes",
    ]);
    assert.deepEqual(refusals({ "CC-BY-NC-4.0": packages("caniuse-lite") }), [
      "caniuse-lite: CC-BY-NC-4.0 is not a license the project takes",
    ]);
  });
});
