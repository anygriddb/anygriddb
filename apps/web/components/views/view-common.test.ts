import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ViewSetupPrompt } from "./view-common";

i18n.load("en", {});
i18n.activate("en");

function render(node: ReactNode) {
  return renderToStaticMarkup(createElement(I18nProvider, { i18n }, node));
}

describe("ViewSetupPrompt", () => {
  it("shows the reason and a way to add a field when the person may", () => {
    const html = render(
      createElement(ViewSetupPrompt, {
        title: "Add a date field to show the timeline.",
        onAddField: () => undefined,
      }),
    );
    expect(html).toContain("Add a date field to show the timeline.");
    expect(html).toContain("Add a field");
  });

  it("shows the reason alone when the schema cannot change", () => {
    const html = render(
      createElement(ViewSetupPrompt, {
        title: "Add a date field to show the timeline.",
      }),
    );
    expect(html).toContain("Add a date field to show the timeline.");
    expect(html).not.toContain("Add a field");
  });
});
