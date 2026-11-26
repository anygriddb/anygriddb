import assert from "node:assert/strict";
import { test } from "node:test";
import { handRefusals } from "./hand-refusals.mjs";

test("finds a refusal written from roleGrants, on one line or several", () => {
  const text = [
    'if (!roleGrants(role, "rows.read")) throw new AppError("x");',
    "if (",
    '  !roleGrantsAll(role, ["base.manage", "data.export"])',
    ") {",
    '  throw new AppError("access_denied");',
    "}",
  ].join("\n");
  assert.deepEqual(handRefusals(text), [1, 3]);
});

test("leaves alone what only filters, and the checks that note their ask", () => {
  const text = [
    'if (!roleGrants(role, "rows.read")) continue;',
    'const shown = tables.filter((table) => roleGrants(role, "rows.read"));',
    'if (!granted(role, "rows.read")) throw new AppError("x");',
    'demand(role, "rows.write");',
  ].join("\n");
  assert.deepEqual(handRefusals(text), []);
});
