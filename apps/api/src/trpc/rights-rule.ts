/**
 * The calls after which someone may hear less, or more, of what their open
 * sockets follow. Each process is told at once and asks again: a channel no
 * longer allowed is left and its page reads again, which is refused. A change
 * this list misses still takes effect at the next heartbeat.
 */
export const RIGHTS_CHANGES: ReadonlySet<string> = new Set([
  "catalog.grant",
  "catalog.revoke",
  "catalog.invite",
  "catalog.setGroupRole",
  "catalog.setTableRole",
  "catalog.setRoleEnd",
  "catalog.splitBaseRole",
  "catalog.setTableAcl",
  "catalog.clearTableAcl",
  "admin.setBaseRole",
  "admin.removeBaseRole",
  "admin.setAdmin",
  "admin.handOver",
  "admin.groups.addMember",
  "admin.groups.removeMember",
  "admin.groups.setBaseRole",
  "admin.groups.delete",
  "admin.attributes.setForAccount",
  "admin.attributes.remove",
  "admin.roles.update",
  "admin.baseOverview.open",
  "admin.baseOverview.close",
]);
