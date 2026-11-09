import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BrandMark } from "./brand-mark";

describe("BrandMark", () => {
  it("is decorative by default", () => {
    const html = renderToStaticMarkup(createElement(BrandMark));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toContain("<title>");
  });

  it("exposes a title when labelled", () => {
    const html = renderToStaticMarkup(
      createElement(BrandMark, { title: "AnyGridDB" }),
    );
    expect(html).toContain("<title>AnyGridDB</title>");
    expect(html).toContain('aria-label="AnyGridDB"');
    expect(html).not.toContain("aria-hidden");
  });
});
