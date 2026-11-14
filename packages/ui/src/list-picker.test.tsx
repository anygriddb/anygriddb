import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ListPicker } from "./list-picker";

function picker(className?: string) {
  return renderToStaticMarkup(
    <ListPicker
      label="Find a person"
      listLabel="People"
      inputValue=""
      onInputChange={() => undefined}
      options={Array.from({ length: 40 }, (_, index) => ({
        id: `p${index}`,
        textValue: `Person ${index}`,
        children: `Person ${index}`,
      }))}
      selectionMode="single"
      selected={[]}
      onToggle={() => undefined}
      empty="Nobody"
      {...(className ? { className } : {})}
    />,
  );
}

/** The element that carries `marker` in its classes, and what it holds. */
function regionOf(markup: string, marker: string): string {
  const start = markup.search(new RegExp(`<div class="[^"]*${marker}`));
  return start < 0 ? "" : markup.slice(start);
}

describe("a list picker that scrolls", () => {
  it("scrolls its search and its list in one region, the search in it", () => {
    const region = regionOf(picker("max-h-48"), "max-h-48");
    expect(region).toContain("<input");
    expect(region).toContain('role="listbox"');
    expect(region.indexOf("<input")).toBeLessThan(
      region.indexOf('role="listbox"'),
    );
  });

  it("gives the list itself no scroll of its own, nor the caller's height", () => {
    const markup = picker("max-h-48");
    const list = /<div[^>]*role="listbox"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(list).not.toBe("");
    expect(list).not.toContain("overflow-y-auto");
    expect(list).not.toContain("max-h-48");
  });
});
