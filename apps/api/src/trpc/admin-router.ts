import { adminAccountProcedures } from "./admin-accounts-router.js";
import { attributesRouter } from "./admin-attributes-router.js";
import { adminBaseProcedures } from "./admin-bases-router.js";
import { groupsRouter } from "./admin-groups-router.js";
import { rolesRouter } from "./admin-roles-router.js";
import { adminInstanceProcedures } from "./admin-instance-router.js";
import {
  apiTokensRouter,
  oidcRouter,
  samlRouter,
  scimRouter,
  siemRouter,
  syslogRouter,
  smtpRouter,
  trailShippingRouter,
} from "./admin-integrations-router.js";
import { notifyRouter } from "./admin-notify-router.js";
import { relaxationsRouter } from "./admin-relaxations-router.js";
import { sourcesRouter } from "./admin-sources-router.js";
import { adminTrailProcedures } from "./admin-trails-router.js";
import { oauthClientsRouter } from "./admin-oauth-router.js";
import { t } from "./init.js";

/**
 * Administration, one file a domain. Every procedure starts from the base
 * of `admin-procedure.ts`, which holds the auditor's rule and the proof.
 */
export const adminRouter = t.router({
  attributes: attributesRouter,
  groups: groupsRouter,
  roles: rolesRouter,
  scim: scimRouter,
  apiTokens: apiTokensRouter,
  oauthClients: oauthClientsRouter,
  sources: sourcesRouter,
  smtp: smtpRouter,
  notify: notifyRouter,
  relaxations: relaxationsRouter,
  oidc: oidcRouter,
  saml: samlRouter,
  siem: siemRouter,
  syslog: syslogRouter,
  trailShipping: trailShippingRouter,
  ...adminInstanceProcedures,
  ...adminAccountProcedures,
  ...adminBaseProcedures,
  ...adminTrailProcedures,
});
