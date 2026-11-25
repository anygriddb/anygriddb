import { grants, type Grant, type ViewItem } from "../../lib/types";

/**
 * Whether a person's settings of a view are stored with it. A personal
 * view is its owner's, a locked one the base's owners', any other an
 * editor's too. Where they are not stored, they stay the person's own for
 * as long as the page is open.
 */
export function canEditView(
  view: ViewItem | undefined,
  role: Grant | null,
  personalOwner: boolean,
): boolean {
  if (!view) return false;
  if (view.personal) return personalOwner;
  return grants(role, view.locked ? "schema.manage" : "views.manage");
}
