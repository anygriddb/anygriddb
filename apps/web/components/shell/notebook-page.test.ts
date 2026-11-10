import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState, NotebookPage, RuledSection } from "./notebook-page";

describe("notebook page", () => {
  it("renders a ruled section with its title", () => {
    const html = renderToStaticMarkup(
      createElement(RuledSection, {
        title: "Members",
        description: "Who can open this base.",
        children: createElement("p", null, "body"),
      }),
    );
    expect(html).toContain("Members");
    expect(html).toContain("Who can open this base.");
    expect(html).toContain("border-rule");
    expect(html).toContain("body");
  });

  it("renders an empty state with an optional action", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        title: "Nothing here yet.",
        description: "Create a base to start.",
        action: createElement("button", { type: "button" }, "New base"),
      }),
    );
    expect(html).toContain("Nothing here yet.");
    expect(html).toContain("New base");
  });

  it("renders a page title at notebook scale", () => {
    const html = renderToStaticMarkup(
      createElement(NotebookPage, {
        title: "Administration",
        description: "Instance",
        children: createElement("div", null, "tabs"),
      }),
    );
    expect(html).toContain("Administration");
    expect(html).toContain("text-[28px]");
  });
});
