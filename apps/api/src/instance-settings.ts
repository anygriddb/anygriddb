/**
 * A change of the instance's settings, with every rule a change has,
 * whoever asks for it: Administration's page and the administration API
 * both come through here, so that neither is a way round the other.
 */
import {
  AppError,
  LIMITS,
  SETTABLE_LIMITS,
  type InstanceSettings,
  type InstanceSettingsPatch,
  type LimitEntry,
  type LimitValues,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { endOtherSessions } from "./admin-control.js";
import { dropPasswordChallenges } from "./auth/challenge.js";
import { parseSignInCidr, SignInAllowList } from "./auth/sign-in-allowlist.js";
import type { Env } from "./env.js";
import { resolveOidc } from "./integrations/oidc.js";
import { resolveSaml } from "./integrations/saml.js";
import { readSettings, writeSettings } from "./settings.js";

/**
 * A limit the environment fixes keeps the value Administration saved for
 * it, unused while the variable is set (ADR 0083): a change of it is
 * refused, whoever asks.
 */
function assertNotFixed(
  after: LimitValues,
  before: LimitValues,
  env: Env,
): void {
  for (const id of SETTABLE_LIMITS) {
    const variable: LimitEntry["fixedBy"] = LIMITS[id].fixedBy;
    if (variable === undefined || env[variable] === undefined) continue;
    if (after[id] !== before[id]) throw new AppError("set_by_environment");
  }
}

export async function saveInstanceSettings(
  deps: {
    db: Database;
    env: Env;
    /** Ends the live connections of an account signed out. */
    closeUser: (userId: string) => void;
    log?: { info: (fields: object, message: string) => void };
  },
  actor: {
    id: string;
    /** Where the change comes from: the sign-in list must not leave it out. */
    ip: string;
    method: "admin" | "admin_token";
  },
  patch: InstanceSettingsPatch,
): Promise<InstanceSettings> {
  // What the environment sets is its operator's to change (ADR 0083).
  if (
    patch.attachmentMaxBytes !== undefined &&
    deps.env.ATTACHMENT_MAX_BYTES !== undefined
  ) {
    throw new AppError("set_by_environment");
  }
  if (patch.ssoOnly === true) {
    const [oidc, saml] = await Promise.all([
      resolveOidc(deps.db, deps.env),
      resolveSaml(deps.db, deps.env),
    ]);
    if (oidc.config === null && saml.config === null) {
      throw new AppError("sso_required");
    }
  }
  if (patch.signInAllowlist) {
    for (const entry of patch.signInAllowlist) {
      parseSignInCidr(entry);
    }
    // A list that leaves out the address it is saved from would refuse
    // its author's next sign-in, and everyone's behind the same proxy:
    // refused, naming the address this server sees.
    if (
      patch.signInAllowlist.length > 0 &&
      !new SignInAllowList(patch.signInAllowlist).allows(actor.ip)
    ) {
      throw new AppError("sign_in_address_left_out", actor.ip);
    }
  }
  // The trail says who changed the limits (ADR 0043); the values, which
  // tell nobody's secret, go to the log beside it (ADR 0132).
  const limitsBefore =
    patch.limits === undefined ? null : (await readSettings(deps.db)).limits;
  if (limitsBefore !== null && patch.limits !== undefined) {
    assertNotFixed(patch.limits, limitsBefore, deps.env);
  }
  await writeSettings(deps.db, actor.id, patch, actor.ip, actor.method);
  if (limitsBefore !== null && patch.limits !== undefined) {
    deps.log?.info(
      { actor: actor.id, before: limitsBefore, after: patch.limits },
      "limits changed",
    );
  }
  if (patch.ssoOnly === true) {
    // A sign-in begun with a password may not finish any more.
    await dropPasswordChallenges(deps.db);
  }
  if (patch.maintenance === true) {
    // Only administrators stay: the others are signed out now.
    const ended = await endOtherSessions(deps.db, actor.id, "non_admins");
    for (const userId of ended) deps.closeUser(userId);
  }
  return readSettings(deps.db);
}
