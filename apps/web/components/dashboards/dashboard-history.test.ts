import { describe, expect, it } from "vitest";
import { UndoStack } from "../../lib/undo-stack";
import {
  DashboardHistory,
  type DashboardWrites,
  type WidgetBody,
  type WidgetPlace,
} from "./dashboard-history";

function metric(title: string, x = 0): WidgetBody {
  return {
    title,
    kind: "metric",
    x,
    y: 0,
    w: 3,
    h: 2,
    config: { tableId: "t", column: "amount", fn: "sum" },
  };
}

/** Widgets kept in memory, each create handing out a new id. */
function memory(): {
  widgets: Map<string, WidgetBody>;
  writes: DashboardWrites;
} {
  const widgets = new Map<string, WidgetBody>();
  let n = 0;
  const writes: DashboardWrites = {
    create: (body) => {
      const id = `w${++n}`;
      widgets.set(id, body);
      return Promise.resolve({ id });
    },
    update: (id, body) => {
      if (!widgets.has(id)) return Promise.reject(new Error(`missing ${id}`));
      widgets.set(id, body);
      return Promise.resolve();
    },
    remove: (id) => {
      if (!widgets.delete(id))
        return Promise.reject(new Error(`missing ${id}`));
      return Promise.resolve();
    },
    layout: (placed) => {
      for (const item of placed) {
        const body = widgets.get(item.id);
        if (!body) return Promise.reject(new Error(`missing ${item.id}`));
        widgets.set(item.id, {
          ...body,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
        });
      }
      return Promise.resolve();
    },
    rename: () => Promise.resolve(),
  };
  return { widgets, writes };
}

describe("a dashboard's undo", () => {
  it("undoes a create and an edit, then redoes them on the recreated widget", async () => {
    const { widgets, writes } = memory();
    const stack = new UndoStack(() => undefined, { keepFailed: true });
    const history = new DashboardHistory(stack);
    history.setWrites(writes);
    const created = await history.add(metric("Total"), "Add");
    await history.edit(created, metric("Total"), metric("Changed"), "Edit");

    await stack.undo();
    expect(widgets.get(created)?.title).toBe("Total");
    await stack.undo();
    expect(widgets.size).toBe(0);

    await stack.redo();
    expect(widgets.size).toBe(1);
    const id = [...widgets.keys()][0];
    if (!id) throw new Error("expected a widget");
    expect(id).not.toBe(created);
    expect(widgets.get(id)?.title).toBe("Total");
    await stack.redo();
    expect(widgets.get(id)?.title).toBe("Changed");
  });

  it("lays a recreated widget out with the move that followed its create", async () => {
    const { widgets, writes } = memory();
    const stack = new UndoStack(() => undefined, { keepFailed: true });
    const history = new DashboardHistory(stack);
    history.setWrites(writes);
    const first = await history.add(metric("A"), "Add");
    const second = await history.add(metric("B", 3), "Add");
    const before: WidgetPlace[] = [
      { id: first, x: 0, y: 0, w: 3, h: 2 },
      { id: second, x: 3, y: 0, w: 3, h: 2 },
    ];
    const after: WidgetPlace[] = [
      { id: second, x: 0, y: 0, w: 3, h: 2 },
      { id: first, x: 3, y: 0, w: 3, h: 2 },
    ];
    await history.move(before, after, "Move");

    await stack.undo();
    await stack.undo();
    await stack.undo();
    expect(widgets.size).toBe(0);
    await stack.redo();
    await stack.redo();
    await stack.redo();

    const places = [...widgets.entries()].map(([id, body]) => ({
      id,
      title: body.title,
      x: body.x,
    }));
    expect(places.map((item) => item.id)).not.toContain(first);
    expect(places.map((item) => item.id)).not.toContain(second);
    expect(places).toEqual([
      { id: places[0]?.id, title: "A", x: 3 },
      { id: places[1]?.id, title: "B", x: 0 },
    ]);
  });

  it("keeps an edit whose undoing failed, and brings a deleted widget back", async () => {
    const { widgets, writes } = memory();
    const stack = new UndoStack(() => undefined, { keepFailed: true });
    const history = new DashboardHistory(stack);
    history.setWrites(writes);
    const created = await history.add(metric("Total"), "Add");
    const after = metric("Changed");
    await history.edit(created, metric("Total"), after, "Edit");
    widgets.delete(created);
    await expect(stack.undo()).rejects.toThrow(`missing ${created}`);
    widgets.set(created, after);
    await stack.undo();
    expect(widgets.get(created)?.title).toBe("Total");

    await history.remove(created, metric("Total"), "Delete");
    await stack.undo();
    const restored = [...widgets.keys()][0];
    if (!restored) throw new Error("expected a widget");
    expect(restored).not.toBe(created);
    expect(widgets.get(restored)?.title).toBe("Total");
    await stack.redo();
    expect(widgets.size).toBe(0);
  });
});
