import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ENGINE_MARKS, EngineMark } from "./engine-mark";

describe("EngineMark", () => {
  for (const engine of Object.keys(ENGINE_MARKS) as Array<
    keyof typeof ENGINE_MARKS
  >) {
    it(`draws ${engine} in its colour`, () => {
      const html = renderToStaticMarkup(createElement(EngineMark, { engine }));
      expect(html).toContain(`fill="${ENGINE_MARKS[engine].color}"`);
      expect(html).toContain('aria-hidden="true"');
    });
  }

  it("names the mark when a title is given", () => {
    const html = renderToStaticMarkup(
      createElement(EngineMark, { engine: "postgres", title: "PostgreSQL" }),
    );
    expect(html).toContain('aria-label="PostgreSQL"');
    expect(html).toContain("<title>PostgreSQL</title>");
  });
});
