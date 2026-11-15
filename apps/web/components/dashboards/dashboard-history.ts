import type { UndoEntry } from "../../lib/undo-stack";

/** What a widget shows and where it sits, without the id the server gives it. */
export type WidgetBody = {
  title: string;
  kind: "metric" | "chart" | "view_embed";
  x: number;
  y: number;
  w: number;
  h: number;
  config: Record<string, unknown>;
};

/** A widget's place, as `dashboards.layout` takes it. */
export type WidgetPlace = {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * The writes a dashboard's undo runs. Creating a widget always returns a
 * new id: undoing a delete, or redoing an add, cannot keep the old one.
 */
export type DashboardWrites = {
  create: (body: WidgetBody) => Promise<{ id: string }>;
  update: (id: string, body: WidgetBody) => Promise<void>;
  remove: (id: string) => Promise<void>;
  layout: (widgets: readonly WidgetPlace[]) => Promise<void>;
  rename: (name: string) => Promise<void>;
};

/**
 * One widget's id for this session. A delete comes back as a new row, and
 * every later step of that widget reads the id written here.
 */
type IdCell = { id: string };

/**
 * The dashboard's changes in this session, recorded after each one has
 * been saved. Undo and redo call the same writes the gesture did, in
 * reverse and forward. Steps share an id cell per widget, so a widget
 * brought back under a new id is the one a later step still names.
 */
export class DashboardHistory {
  private current: DashboardWrites | null = null;
  private readonly cells: IdCell[] = [];

  constructor(private readonly stack: { push: (entry: UndoEntry) => void }) {}

  /** Replaced when the screen renders again, so undo calls the latest writes. */
  setWrites(writes: DashboardWrites): void {
    this.current = writes;
  }

  private writes(): DashboardWrites {
    if (!this.current) throw new Error("Internal error");
    return this.current;
  }

  private cellFor(id: string): IdCell {
    const found = this.cells.find((cell) => cell.id === id);
    if (found) return found;
    const cell = { id };
    this.cells.push(cell);
    return cell;
  }

  async add(body: WidgetBody, label: string): Promise<string> {
    const created = await this.writes().create(body);
    const cell = this.cellFor(created.id);
    this.stack.push({
      label,
      undo: () => this.writes().remove(cell.id),
      redo: async () => {
        const again = await this.writes().create(body);
        cell.id = again.id;
      },
    });
    return created.id;
  }

  async edit(
    id: string,
    before: WidgetBody,
    after: WidgetBody,
    label: string,
  ): Promise<void> {
    const cell = this.cellFor(id);
    await this.writes().update(cell.id, after);
    this.stack.push({
      label,
      undo: () => this.writes().update(cell.id, before),
      redo: () => this.writes().update(cell.id, after),
    });
  }

  async remove(id: string, body: WidgetBody, label: string): Promise<void> {
    const cell = this.cellFor(id);
    await this.writes().remove(cell.id);
    this.stack.push({
      label,
      undo: async () => {
        const created = await this.writes().create(body);
        cell.id = created.id;
      },
      redo: () => this.writes().remove(cell.id),
    });
  }

  async move(
    before: readonly WidgetPlace[],
    after: readonly WidgetPlace[],
    label: string,
  ): Promise<void> {
    const past = before.map((item) => this.placed(item));
    const next = after.map((item) => this.placed(item));
    await this.writes().layout(this.resolve(next));
    this.stack.push({
      label,
      undo: () => this.writes().layout(this.resolve(past)),
      redo: () => this.writes().layout(this.resolve(next)),
    });
  }

  async rename(before: string, after: string, label: string): Promise<void> {
    await this.writes().rename(after);
    this.stack.push({
      label,
      undo: () => this.writes().rename(before),
      redo: () => this.writes().rename(after),
    });
  }

  private placed(item: WidgetPlace): {
    cell: IdCell;
    x: number;
    y: number;
    w: number;
    h: number;
  } {
    return {
      cell: this.cellFor(item.id),
      x: item.x,
      y: item.y,
      w: item.w,
      h: item.h,
    };
  }

  private resolve(
    items: readonly {
      cell: IdCell;
      x: number;
      y: number;
      w: number;
      h: number;
    }[],
  ): WidgetPlace[] {
    return items.map(({ cell, x, y, w, h }) => ({
      id: cell.id,
      x,
      y,
      w,
      h,
    }));
  }
}
