import assert from "node:assert/strict";
import { test } from "node:test";
import { conflictMarkers } from "./conflict-markers.mjs";

const mark = (sign) => sign.repeat(7);

test("finds a merge's markers, as Git writes them and as Prettier moves them", () => {
  const text = [
    `${mark("<")} HEAD`,
    "ours",
    `  ${mark("|")} parent of 1234abc (a change)`,
    "theirs",
    `${mark(">")} origin/main`,
    `| ${mark("<")} HEAD |`,
    "> > > > > > > origin/main",
  ].join("\n");
  assert.deepEqual(conflictMarkers(text), [1, 3, 5, 6, 7]);
});

test("leaves alone a title's underline, a table and a quote", () => {
  const text = [
    "Title",
    mark("="),
    "| a | b |",
    "| --- | --- |",
    "> a quote > with > signs",
    "a << b >> c",
  ].join("\n");
  assert.deepEqual(conflictMarkers(text), []);
});
