import type { RouterOutputs } from "./trpc";

export type CatalogBase = RouterOutputs["catalog"]["list"][number];
export type CatalogTable = CatalogBase["tables"][number];
export type CatalogColumn = CatalogTable["columns"][number];
export type ViewItem = RouterOutputs["catalog"]["views"]["views"][number];
export type ViewConfig = ViewItem["config"];
export type RowItem = RouterOutputs["rows"]["read"]["rows"][number];
export type Collaborator =
  RouterOutputs["catalog"]["collaborators"]["users"][number];
export type Role = "owner" | "editor" | "commenter" | "viewer";

export function canWrite(role: Role | null | undefined): boolean {
  return role === "owner" || role === "editor";
}

export function canManage(role: Role | null | undefined): boolean {
  return role === "owner";
}

export function canComment(role: Role | null | undefined): boolean {
  return role === "owner" || role === "editor" || role === "commenter";
}
