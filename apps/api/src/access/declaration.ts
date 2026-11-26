/**
 * What each way in asks, said where it is defined: a procedure, an HTTP
 * route, a socket's message, an MCP tool, a job. A check that asks a
 * permission the way in did not declare is a declaration left behind: the
 * tests refuse it, an operator's instance counts it and the check itself
 * still decides.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  AppError,
  callersHold,
  type Grant,
  instanceCallers,
  type InstanceRole,
  INSTANCE_PERMISSIONS,
  type InstancePermission,
  PERMISSIONS,
  type Permission,
  roleGrants,
} from "@anygriddb/core";
import { z } from "zod";
import { undeclaredPermissionCounted } from "../observability.js";

/** A permission of a base, or of Administration. */
export type Asked = Permission | InstancePermission;

/**
 * Why a way in asks no permission of its caller, each reason once. A name
 * joins this list for such a reason, never to make a test pass.
 */
export const EXCEPTIONS = {
  signIn:
    "Signing in and up, and what the sign-in page shows: who calls is not known yet",
  secondFactor:
    "The second step of signing in, under the challenge the first step gave",
  invitation:
    "An invitation's link, read before signing in: the invitation names who may take it",
  publicLink:
    "A public link opens what its maker shares, and asks of the maker what it declares",
  unsubscribe:
    "A mail's unsubscribe link: signed, it names the person and one preference (ADR 0123)",
  ownAccount:
    "The account about itself: its profile, factors, sessions, tokens, notifications and shortcuts",
  ownBases:
    "What a signed-in person reads of the bases they reach, each one by what it gives them",
  proof:
    "The proof every change of Administration asks for, by whoever may change something there",
  instance: "Work the instance does for itself, in no one's name",
  operator:
    "What the operator reads: health and readiness, metrics behind their token, the authority's certificate",
  page: "The application's own page and files, the instance's logo, a page's failure report",
  socket: "The socket's door: each message sent on it declares what it asks",
  procedures: "The procedures' door: each procedure declares what it asks",
  provider:
    "An identity provider's call back, checked by what the protocol signs",
  application:
    "An application's OAuth exchange, checked by its client's proof and its grant",
  provisioning: "The SCIM directory's calls, checked by its token's scope",
  administrationApi:
    "The administration API's calls, checked by its token's scope (ADR 0086)",
  inboundHook:
    "An automation's address, opened by the secret it holds; the run asks its author",
  feed: "A calendar feed, opened by the secret it holds, asks its maker what it declares",
  tools: "The MCP door: each tool declares what it asks",
} as const;
export type ExceptionKey = keyof typeof EXCEPTIONS;

/**
 * What a way in asks. `asks` holds on a plain call, its input at its
 * defaults; `also` on others, as the input or what is found says (a copy
 * with its rows asks for an export, a personal view only to read);
 * `filters` is what a list leaves out rather than refuses.
 */
export type Declaration = {
  asks?: readonly Asked[];
  also?: readonly Asked[];
  filters?: readonly Asked[];
  exception?: ExceptionKey;
};

const asked = z.enum([...PERMISSIONS, ...INSTANCE_PERMISSIONS]);

/** The shape a declaration must have, for the tests that walk them. */
export const declarationSchema = z
  .object({
    asks: z.array(asked).min(1).optional(),
    also: z.array(asked).min(1).optional(),
    filters: z.array(asked).min(1).optional(),
    exception: z.enum(Object.keys(EXCEPTIONS) as [ExceptionKey]).optional(),
  })
  .strict()
  .refine(
    (declaration) =>
      declaration.asks !== undefined ||
      declaration.filters !== undefined ||
      declaration.exception !== undefined,
    "A way in asks a permission, filters by one, or names its exception",
  );

/** Everything a declaration names, whichever key holds it. */
export function declaredPermissions(
  declaration: Declaration,
): ReadonlySet<Asked> {
  return new Set([
    ...(declaration.asks ?? []),
    ...(declaration.also ?? []),
    ...(declaration.filters ?? []),
  ]);
}

type Call = {
  entry: string;
  declaration: Declaration;
  declared: ReadonlySet<Asked>;
  warn: (message: string) => void;
};

const calls = new AsyncLocalStorage<Call>();

/** Runs a way in under its declaration. */
export function runDeclared<T>(
  entry: string,
  declaration: Declaration,
  run: () => T,
  warn: (message: string) => void = () => undefined,
): T {
  return calls.run(
    {
      entry,
      declaration,
      declared: declaredPermissions(declaration),
      warn,
    },
    run,
  );
}

/** The declaration of the way in under way, if any. */
export function currentDeclaration(): Declaration | undefined {
  return calls.getStore()?.declaration;
}

/** What a check heard: for the test that calls every way in without. */
export type Demand = {
  entry: string | null;
  permission: Asked;
  granted: boolean;
};

const watchers = new Set<(demand: Demand) => void>();

/** Hears every check: `refused.integration.test.ts` reads them. */
export function watchDemands(watcher: (demand: Demand) => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** Notes a check: what it asked, and whether the way in declared it. */
export function noteDemand(permission: Asked, granted: boolean): void {
  const call = calls.getStore();
  for (const watcher of watchers) {
    watcher({ entry: call?.entry ?? null, permission, granted });
  }
  if (!call || call.declared.has(permission)) return;
  undeclaredPermissionCounted();
  const message = `${call.entry} asks ${permission} without declaring it`;
  // The tests walk every way in: a declaration left behind fails there,
  // said in full where the log would keep only the error's kind.
  if (process.env.VITEST) {
    console.error(`UNDECLARED ${message}`);
    throw new Error(message);
  }
  call.warn(message);
}

/** Whether the role gives the permission, the check noted. */
export function granted(
  role: Grant | null | undefined,
  permission: Permission,
) {
  const answer = roleGrants(role, permission);
  noteDemand(permission, answer);
  return answer;
}

/**
 * The check of a base's or a table's permission: refused, as every guard
 * refuses, unless the role gives it.
 */
export function demand(
  role: Grant | null | undefined,
  permission: Permission,
  refusal: "access_denied" | "not_found" = "access_denied",
): asserts role is Grant {
  if (!granted(role, permission)) throw new AppError(refusal);
}

/** The same check for an act that is several acts. */
export function demandAll(
  role: Grant | null | undefined,
  permissions: readonly Permission[],
): asserts role is Grant {
  for (const permission of permissions) demand(role, permission);
}

/** What an account is in Administration. */
export type InstanceFlags = {
  isAdmin: boolean;
  isSupport: boolean;
  isAuditor: boolean;
  instanceRoles: readonly InstanceRole[];
};

/** Whether the account holds a permission of Administration, the check noted. */
export function holds(
  account: InstanceFlags,
  permission: InstancePermission,
): boolean {
  const answer = callersHold(instanceCallers(account), permission);
  noteDemand(permission, answer);
  return answer;
}
