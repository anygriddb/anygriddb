import type { RouterOutputs } from "./trpc";

export type CatalogBase = RouterOutputs["catalog"]["list"][number];
export type CatalogTable = CatalogBase["tables"][number];
export type CatalogColumn = CatalogTable["columns"][number];
export type ViewItem = RouterOutputs["catalog"]["views"]["views"][number];
export type ViewConfig = ViewItem["config"];
export type RowItem = RouterOutputs["rows"]["read"]["rows"][number];
export type Collaborator =
  RouterOutputs["catalog"]["collaborators"]["users"][number];
export type { Given, Grant, Permission } from "@anygriddb/core";

/**
 * Whether a role on a base or a table gives an act: the server's own rule
 * (ADR 0127), so a screen offers what the server then accepts.
 */
export { roleGrants as grants } from "@anygriddb/core";
