import { adminAccountProcedures } from "./admin-accounts-router.js";
import { adminBaseProcedures } from "./admin-bases-router.js";
import { groupsRouter } from "./admin-groups-router.js";
import { adminInstanceProcedures } from "./admin-instance-router.js";
import {
  apiTokensRouter,
  oidcRouter,
  samlRouter,
  scimRouter,
  siemRouter,
  syslogRouter,
  smtpRouter,
} from "./admin-integrations-router.js";
import { notifyRouter } from "./admin-notify-router.js";
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
  apiTokens: apiTokensRouter,
  sources: sourcesRouter,
  smtp: smtpRouter,
  notify: notifyRouter,
  oidc: oidcRouter,
  saml: samlRouter,
  siem: siemRouter,
  syslog: syslogRouter,
  ...adminInstanceProcedures,
  ...adminAccountProcedures,
  ...adminBaseProcedures,
  ...adminTrailProcedures,
});
