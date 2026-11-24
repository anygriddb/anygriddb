/**
 * What each part of Administration given apart opens (ROADMAP #34, ADR
 * 0126): an account manager, the accounts and the groups; a source
 * manager, the client databases. A procedure not named here stays an
 * administrator's alone, so one added later is closed to them without a
 * word: opening it is a line written here.
 */
import type { InstanceRole } from "@anygriddb/core";

type Area = "proof" | "accounts" | "groups" | "sources";

const AREAS: Readonly<Record<InstanceRole, readonly Area[]>> = {
  account_manager: ["proof", "accounts", "groups"],
  source_manager: ["proof", "sources"],
};

/**
 * The procedures each area holds. Never here: what gives a role of
 * Administration, or a role on a base (a group's included), erases an
 * account, acts as one, hands what it owns to another, or takes its data
 * out; and what concerns the whole instance at once.
 */
export const DELEGATED_PROCEDURES: Readonly<Record<string, Area>> = {
  // The proof every change asks for, and whether it is still fresh.
  "admin.stepUp": "proof",
  "admin.stepUpStatus": "proof",
  // The accounts, one account's page, its sessions, and what a helpdesk
  // does, on the accounts that hold no role of Administration
  // (`helpdeskReach`). An account made here is no administrator and has
  // no base.
  "admin.users": "accounts",
  "admin.account": "accounts",
  "admin.createAccount": "accounts",
  "admin.updateAccount": "accounts",
  "admin.setDisabled": "accounts",
  "admin.disableAccounts": "accounts",
  "admin.sessions": "accounts",
  "admin.endSession": "accounts",
  "admin.endUserSessions": "accounts",
  "admin.unlock": "accounts",
  "admin.sendPasswordReset": "accounts",
  "admin.clearFactors": "accounts",
  "admin.unlinkSignOn": "accounts",
  "admin.revokeTokens": "accounts",
  // The groups and who is in them; the role a group holds on a base stays
  // with an administrator and the base's owners.
  "admin.groups.list": "groups",
  "admin.groups.get": "groups",
  "admin.groups.create": "groups",
  "admin.groups.update": "groups",
  "admin.groups.delete": "groups",
  "admin.groups.addMember": "groups",
  "admin.groups.removeMember": "groups",
  // The client databases, what they expose, and into which bases: those
  // the source manager owns (`exposeTables`).
  "admin.sources.settings": "sources",
  "admin.sources.list": "sources",
  "admin.sources.test": "sources",
  "admin.sources.create": "sources",
  "admin.sources.update": "sources",
  "admin.sources.delete": "sources",
  "admin.sources.check": "sources",
  "admin.sources.expose": "sources",
  "admin.sources.exposures": "sources",
  "admin.sources.setWrites": "sources",
  "admin.sources.refreshTable": "sources",
  "admin.sources.setWatch": "sources",
  "admin.sources.setSync": "sources",
  "admin.sources.syncNow": "sources",
  "admin.sources.tables": "sources",
  "admin.sources.tableListing": "sources",
};

/** Whether one of these roles opens the procedure at `path`. */
export function delegatedMayCall(
  roles: readonly InstanceRole[],
  path: string,
): boolean {
  const area = DELEGATED_PROCEDURES[path];
  return area !== undefined && roles.some((role) => AREAS[role].includes(area));
}
