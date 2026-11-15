/**
 * A change of the instance's settings, with every rule a change has,
 * whoever asks for it: Administration's page and the administration API
 * both come through here, so that neither is a way round the other.
 */
import {
  AppError,
  type InstanceSettings,
  type InstanceSettingsPatch,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { endOtherSessions } from "./admin-control.js";
import { parseSignInCidr, SignInAllowList } from "./auth/sign-in-allowlist.js";
import type { Env } from "./env.js";
import { resolveOidc } from "./integrations/oidc.js";
import { resolveSaml } from "./integrations/saml.js";
import { readSettings, writeSettings } from "./settings.js";

export async function saveInstanceSettings(
  deps: {
    db: Database;
    env: Env;
    /** Ends the live connections of an account signed out. */
    closeUser: (userId: string) => void;
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
  await writeSettings(deps.db, actor.id, patch, actor.ip, actor.method);
  if (patch.maintenance === true) {
    // Only administrators stay: the others are signed out now.
    const ended = await endOtherSessions(deps.db, actor.id, "non_admins");
    for (const userId of ended) deps.closeUser(userId);
  }
  return readSettings(deps.db);
}
