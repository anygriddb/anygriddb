import { catalogAccessProcedures } from "./catalog-access-router.js";
import { catalogBaseProcedures } from "./catalog-bases-router.js";
import { catalogFieldProcedures } from "./catalog-fields-router.js";
import { catalogSharingProcedures } from "./catalog-sharing-router.js";
import { catalogTableProcedures } from "./catalog-tables-router.js";
import { catalogTrashProcedures } from "./catalog-trash-router.js";
import { catalogViewProcedures } from "./catalog-views-router.js";
import { t } from "./init.js";

/**
 * The catalog, one file a domain: bases, tables, fields, views, who may
 * do what, what leaves a base, and the trash.
 */
export const catalogRouter = t.router({
  ...catalogBaseProcedures,
  ...catalogTableProcedures,
  ...catalogFieldProcedures,
  ...catalogViewProcedures,
  ...catalogAccessProcedures,
  ...catalogSharingProcedures,
  ...catalogTrashProcedures,
});
