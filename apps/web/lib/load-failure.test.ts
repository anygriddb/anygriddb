import { describe, expect, it, vi } from "vitest";
import { showLoadFailure } from "./load-failure";

type Node = {
  tag: string;
  attributes: Record<string, string>;
  className: string;
  textContent: string;
  type: string;
  children: Node[];
  click: () => void;
};

/** A stand-in for the document: tests run without a browser. */
function page() {
  const createElement = (tag: string) => {
    const listeners: Array<() => void> = [];
    const node = {
      tag,
      attributes: {} as Record<string, string>,
      className: "",
      textContent: "",
      type: "",
      children: [] as Node[],
      setAttribute(name: string, value: string) {
        node.attributes[name] = value;
      },
      addEventListener(_event: string, listener: () => void) {
        listeners.push(listener);
      },
      append(...children: Node[]) {
        node.children.push(...children);
      },
      click() {
        for (const listener of listeners) listener();
      },
    };
    return node;
  };
  let shown: Node[] = [];
  const root = {
    replaceChildren: (...nodes: Node[]) => {
      shown = nodes;
    },
  };
  return {
    document: { createElement } as unknown as Pick<Document, "createElement">,
    root: root as unknown as Pick<HTMLElement, "replaceChildren">,
    shown: () => shown,
  };
}

describe("a page whose words could not be loaded", () => {
  it("says so in the person's language, with a way to reload", () => {
    const stand = page();
    const reload = vi.fn();
    showLoadFailure(stand.root, "fr", reload, stand.document);
    const [box] = stand.shown();
    expect(box?.attributes.role).toBe("alert");
    expect(box?.children.map((node) => node.tag)).toEqual(["p", "button"]);
    expect(box?.children[0]?.textContent).toContain("rechargez la page");
    expect(box?.children[1]?.textContent).toBe("Recharger la page");
    expect(box?.children[1]?.type).toBe("button");
    box?.children[1]?.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("replaces what the page held, and does not reload on its own", () => {
    const stand = page();
    const reload = vi.fn();
    showLoadFailure(stand.root, "en", reload, stand.document);
    showLoadFailure(stand.root, "en", reload, stand.document);
    expect(stand.shown()).toHaveLength(1);
    expect(stand.shown()[0]?.children[0]?.textContent).toBe(
      "AnyGridDB could not be loaded. Check your connection, then reload the page.",
    );
    expect(reload).not.toHaveBeenCalled();
  });
});
