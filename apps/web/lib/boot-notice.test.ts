import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

// What the page shows while the app has not drawn: the document itself
// holds it, since a script that was refused or lost on the way is what
// would otherwise leave the page blank. These read the document and the
// script that runs before the app, as a browser gets them.
const read = (path: string) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const page = read("../index.html");
const early = read("../public/theme.js");

describe("the page before the app has drawn", () => {
  const root = /<div id="root"[^>]*>([\s\S]*?)<\/div>\s*<script/.exec(
    page,
  )?.[1];

  it("holds a word and a way to reload, in both languages, that need no script", () => {
    expect(root).toBeDefined();
    for (const [language, action] of [
      ["en", "reload the page"],
      ["fr", "rechargez la page"],
    ]) {
      const said = new RegExp(
        `<p lang="${language}">[\\s\\S]*?<a href="">${action}</a>[\\s\\S]*?</p>`,
      ).exec(root ?? "");
      expect(said, language).not.toBeNull();
    }
    // A link to the page itself reloads it: nothing to run.
    expect(root).not.toMatch(/<button|onclick|<script/i);
  });

  it("shows it only once the app is late, and without the app's style sheet", () => {
    const style = /<style>([\s\S]*?)<\/style>/.exec(page)?.[1] ?? "";
    expect(style).toMatch(/#boot\s*\{[^}]*visibility:\s*hidden/);
    expect(style).toMatch(
      /#boot\s*\{[^}]*animation:\s*boot-late 0s \d+s forwards/,
    );
    expect(style).toMatch(/@keyframes boot-late[\s\S]*visibility:\s*visible/);
    // One language at a time: English unless the page says French.
    expect(style).toMatch(/:root\[lang="fr"\] #boot \[lang="en"\]/);
    expect(style).not.toMatch(/var\(--|@import|url\(/);
  });

  it("carries no script of its own: the policy allows none", () => {
    const inline = [...page.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(inline.length).toBeGreaterThan(0);
    for (const [, attributes, body] of inline) {
      expect(attributes).toMatch(/\bsrc="/);
      expect(body?.trim()).toBe("");
    }
  });
});

describe("the page's language, said before the app", () => {
  /** Runs the early script as a browser would, and answers the language set. */
  function language(input: {
    picked?: string | null;
    blocked?: boolean;
    languages?: string[];
    fallback?: string;
  }): string {
    const document = { documentElement: { lang: "en", dataset: {} } };
    runInNewContext(early, {
      document,
      navigator: {
        languages: input.languages ?? [],
        language: input.fallback ?? "",
      },
      window: {
        localStorage: {
          getItem: (key: string) => {
            if (input.blocked) throw new Error("blocked");
            return key === "ag_locale" ? (input.picked ?? null) : null;
          },
        },
        matchMedia: () => ({ matches: false }),
      },
    });
    return document.documentElement.lang;
  }

  it("is the one the person picked, or the browser's first the app speaks", () => {
    expect(language({ picked: "fr", languages: ["en-GB"] })).toBe("fr");
    expect(language({ picked: "en", languages: ["fr-FR"] })).toBe("en");
    expect(language({ languages: ["de-DE", "fr-CA", "en-US"] })).toBe("fr");
    expect(language({ languages: ["en-US", "fr-FR"] })).toBe("en");
    expect(language({ languages: [], fallback: "fr" })).toBe("fr");
  });

  it("is English for a language the app does not speak, and whatever storage does", () => {
    expect(language({ languages: ["de-DE", "es"] })).toBe("en");
    expect(language({ picked: "de", languages: ["it"] })).toBe("en");
    // Storage that refuses to be read leaves the browser's languages.
    expect(language({ blocked: true, languages: ["fr-FR"] })).toBe("fr");
    expect(language({ blocked: true, languages: [] })).toBe("en");
  });
});
