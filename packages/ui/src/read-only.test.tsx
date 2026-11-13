import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./button";
import { Checkbox, Input, Select, Textarea } from "./input";
import { ReadOnly } from "./read-only";

function controls() {
  return (
    <>
      <Button>Save</Button>
      <Input aria-label="Name" />
      <Textarea aria-label="Note" />
      <Select aria-label="Role">
        <option>Owner</option>
      </Select>
      <Checkbox aria-label="Told" />
    </>
  );
}

const disabled = (markup: string) => markup.match(/ disabled=""/g)?.length ?? 0;

describe("a region that is only read", () => {
  it("leaves every control on where nothing says otherwise", () => {
    expect(disabled(renderToStaticMarkup(controls()))).toBe(0);
    expect(
      disabled(
        renderToStaticMarkup(<ReadOnly when={false}>{controls()}</ReadOnly>),
      ),
    ).toBe(0);
  });

  it("turns every control off, a control added later too", () => {
    expect(
      disabled(renderToStaticMarkup(<ReadOnly when>{controls()}</ReadOnly>)),
    ).toBe(5);
  });

  it("keeps on what only reads, and a link drawn as a button", () => {
    const markup = renderToStaticMarkup(
      <ReadOnly when>
        <Button reads>Next</Button>
        <Input reads aria-label="Search" />
        <Select reads aria-label="Status">
          <option>All</option>
        </Select>
        <Checkbox reads aria-label="Without an owner" />
        <Button asChild>
          <a href="/admin">Administration</a>
        </Button>
        <Button reads disabled>
          Older
        </Button>
      </ReadOnly>,
    );
    // Only the one its page turned off itself.
    expect(disabled(markup)).toBe(1);
    expect(markup).not.toContain("reads");
  });
});
