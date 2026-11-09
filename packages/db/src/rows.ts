/** Row types of the catalog tables, as Kysely reads and writes them. */
import type { Insertable, Selectable } from "kysely";
import type { DB } from "./types.generated.js";

export type Row<T extends keyof DB> = Selectable<DB[T]>;
export type NewRow<T extends keyof DB> = Insertable<DB[T]>;

export type BaseRow = Row<"bases">;
export type TableRow = Row<"dataTables">;
export type ColumnRow = Row<"dataColumns">;
export type RelationRow = Row<"relations">;
export type ViewRow = Row<"views">;
export type JobRow = Row<"jobs">;
export type WebhookRow = Row<"webhooks">;
export type DeliveryRow = Row<"webhookDeliveries">;
export type AutomationRow = Row<"automations">;
export type UserRow = Row<"users">;
export type ShareRow = Row<"shares">;
export type DashboardRow = Row<"dashboards">;
export type WidgetRow = Row<"dashboardWidgets">;
