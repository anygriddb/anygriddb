import { adminAccountProcedures } from "./admin-accounts-router.js";
import { adminBaseProcedures } from "./admin-bases-router.js";
import { groupsRouter } from "./admin-groups-router.js";
import { adminInstanceProcedures } from "./admin-instance-router.js";
import {
  oidcRouter,
  samlRouter,
  scimRouter,
  siemRouter,
  smtpRouter,
} from "./admin-integrations-router.js";
import { sourcesRouter } from "./admin-sources-router.js";
import { adminTrailProcedures } from "./admin-trails-router.js";
import { t } from "./init.js";

/**
 * Administration, one file a domain. Every procedure starts from the base
 * of `admin-procedure.ts`, which holds the auditor's rule and the proof.
 */
export const adminRouter = t.router({
  groups: groupsRouter,
  scim: scimRouter,
  sources: sourcesRouter,
  smtp: smtpRouter,
  oidc: oidcRouter,
  saml: samlRouter,
  siem: siemRouter,
  ...adminInstanceProcedures,
  ...adminAccountProcedures,
  ...adminBaseProcedures,
  ...adminTrailProcedures,
});
