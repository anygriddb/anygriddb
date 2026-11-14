/**
 * Accounts by the dozen (ROADMAP #36): several disabled together, and the
 * people of a file added at once. Each account still goes through what
 * one account goes through (`setUserDisabled`, `createAccount`): the
 * rules and the trail are the same, only the gesture is shorter.
 */
import {
  AppError,
  memberDomainAllowed,
  readPeopleFile,
  type PeopleFileProblem,
  type Role,
} from "@anygriddb/core";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { z } from "zod";
import { createAccount, setUserDisabled } from "./admin.js";
import {
  ACCOUNT_LINK_TTL_MS,
  createResetLink,
  passwordState,
} from "./auth/password-reset.js";
import { sendWelcome, type SecurityMailDeps } from "./auth/security-mail.js";
import { ERASED_USER_ID } from "./data/erasure.js";
import { liveBase } from "./data/live.js";
import { addJob, TASKS } from "./queue/jobs.js";
import { readGateSettings } from "./settings.js";

/** Accounts one gesture may disable. */
export const BULK_ACCOUNTS_MAX = 100;

export const bulkDisableInputSchema = z
  .object({ userIds: z.array(z.uuid()).min(1).max(BULK_ACCOUNTS_MAX) })
  .strict();

/**
 * Disables each account as one would be: its sessions end and its API
 * tokens stop working. One that cannot be (the administrator's own, one
 * deleted since the list was read) is told apart and stops nothing.
 */
export async function disableAccounts(
  db: Database,
  actorId: string,
  userIds: readonly string[],
): Promise<{ disabled: string[]; refused: string[] }> {
  const disabled: string[] = [];
  const refused: string[] = [];
  for (const userId of new Set(userIds)) {
    try {
      await setUserDisabled(db, actorId, userId, true);
      disabled.push(userId);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      refused.push(userId);
    }
  }
  return { disabled, refused };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PeopleLine = {
  line: number;
  email: string;
  displayName: string;
  bases: { baseId: string; name: string; role: Role }[];
  problem: PeopleFileProblem | null;
  /** The base as the file writes it, when it is what stops the line. */
  base: string | null;
};

/**
 * A file of people, read against the instance and nothing written: who
 * would be added, on which bases, and why a line would add nobody. A
 * base is found by its id, or by its name when one live base alone has
 * it: a name two bases share is never guessed.
 */
export async function previewPeople(
  db: Database,
  text: string,
): Promise<{ lines: PeopleLine[]; ready: number }> {
  const read = readPeopleFile(text);
  const sound = read.filter((line) => line.problem === null);
  const written = [
    ...new Set(sound.flatMap((line) => line.bases.map((row) => row.base))),
  ];
  const ids = written.filter((base) => UUID.test(base));
  const [taken, bases, gate] = await Promise.all([
    sound.length === 0
      ? []
      : db
          .selectFrom("users")
          .select("email")
          .where(
            sql<string>`lower(email)`,
            "in",
            sound.map((line) => line.email),
          )
          .where("id", "<>", ERASED_USER_ID)
          .execute(),
    written.length === 0
      ? []
      : db
          .selectFrom("bases as b")
          .select(["b.id", "b.name"])
          .where(liveBase("b"))
          .where((eb) =>
            eb.or([
              eb(
                sql<string>`lower(b.name)`,
                "in",
                written.map((base) => base.toLowerCase()),
              ),
              ...(ids.length > 0 ? [eb("b.id", "in", ids)] : []),
            ]),
          )
          .execute(),
    readGateSettings(db),
  ]);
  const hasAccount = new Set(taken.map((row) => row.email.toLowerCase()));
  const byId = new Map(bases.map((base) => [base.id, base]));
  const byName = new Map<string, typeof bases>();
  for (const base of bases) {
    const name = base.name.toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), base]);
  }

  const lines = read.map((line): PeopleLine => {
    const stopped = (
      problem: PeopleFileProblem,
      base: string | null = null,
    ): PeopleLine => ({
      line: line.line,
      email: line.email,
      displayName: line.displayName,
      bases: [],
      problem,
      base,
    });
    if (line.problem) return stopped(line.problem);
    if (hasAccount.has(line.email)) return stopped("account_exists");
    const found: PeopleLine["bases"] = [];
    for (const { base, role } of line.bases) {
      const named = byName.get(base.toLowerCase()) ?? [];
      const one = byId.get(base.toLowerCase()) ?? named[0];
      if (!one) return stopped("unknown_base", base);
      if (!byId.has(base.toLowerCase()) && named.length > 1) {
        return stopped("ambiguous_base", base);
      }
      if (found.some((row) => row.baseId === one.id)) {
        return stopped("invalid_bases", base);
      }
      found.push({ baseId: one.id, name: one.name, role });
    }
    // As when one person is added: the domains invitations are limited
    // to bind an address that gets a role, not one that gets none.
    if (found.length > 0 && !memberDomainAllowed(line.email, gate)) {
      return stopped("domain_not_allowed");
    }
    return {
      line: line.line,
      email: line.email,
      displayName: line.displayName,
      bases: found,
      problem: null,
      base: null,
    };
  });
  return {
    lines,
    ready: lines.filter((line) => line.problem === null).length,
  };
}

/** What `createAccount` refuses, said as the preview says it. */
const REFUSALS: Partial<Record<string, PeopleFileProblem>> = {
  account_already_exists: "account_exists",
  not_found: "unknown_base",
  invitation_domain_not_allowed: "domain_not_allowed",
};

/**
 * Adds the people of a file whose line is in order, each as one person
 * is added, never as an administrator: that is given one account at a
 * time, with its proof. The file is read again here: what the page
 * showed is not what is trusted. Each account's first link is mailed by
 * the queue, so the request does not wait on the mail server.
 */
export async function addPeople(
  db: Database,
  actor: { id: string; displayName: string },
  text: string,
): Promise<{
  added: number;
  refused: { line: number; email: string; problem: PeopleFileProblem }[];
  /** The roles given, for the notice to each base's owners. */
  given: { baseId: string; userId: string; role: Role }[];
}> {
  const { lines } = await previewPeople(db, text);
  const given: { baseId: string; userId: string; role: Role }[] = [];
  const refused: {
    line: number;
    email: string;
    problem: PeopleFileProblem;
  }[] = [];
  let added = 0;
  for (const line of lines) {
    if (line.problem) {
      refused.push({
        line: line.line,
        email: line.email,
        problem: line.problem,
      });
      continue;
    }
    try {
      const account = await createAccount(db, actor.id, {
        email: line.email,
        displayName: line.displayName,
        admin: false,
        memberships: line.bases.map(({ baseId, role }) => ({ baseId, role })),
      });
      const payload: AccountWelcomePayload = {
        userId: account.id,
        actorId: actor.id,
        creatorName: actor.displayName,
      };
      await addJob(db, TASKS.accountWelcome, payload, { maxAttempts: 3 });
      added += 1;
      for (const { baseId, role } of line.bases) {
        given.push({ baseId, userId: account.id, role });
      }
    } catch (error) {
      // Changed since the file was read: an address taken, a base deleted.
      const problem =
        error instanceof AppError ? REFUSALS[error.code] : undefined;
      if (!problem) throw error;
      refused.push({ line: line.line, email: line.email, problem });
    }
  }
  return { added, refused, given };
}

export const accountWelcomePayloadSchema = z.object({
  userId: z.uuid(),
  actorId: z.uuid(),
  creatorName: z.string(),
});
export type AccountWelcomePayload = z.infer<typeof accountWelcomePayloadSchema>;

/**
 * Mails the first link of an account a file added. The link is made
 * here, when it is sent: none waits in the queue, where it would be a
 * password to be. Nothing is sent to an account disabled or deleted
 * since, or that has its password already; without email set up the job
 * fails, and is tried again.
 */
export async function deliverWelcome(
  deps: SecurityMailDeps,
  payload: AccountWelcomePayload,
): Promise<boolean> {
  const [account, actor] = await Promise.all([
    deps.db
      .selectFrom("users")
      .select("id")
      .where("id", "=", payload.userId)
      .where("disabledAt", "is", null)
      .executeTakeFirst(),
    deps.db
      .selectFrom("users")
      .select("id")
      .where("id", "=", payload.actorId)
      .executeTakeFirst(),
  ]);
  if (!account) return false;
  if ((await passwordState(deps.db, payload.userId)) !== "unset") return false;
  const link = await createResetLink(deps.db, {
    userId: payload.userId,
    createdBy: actor ? payload.actorId : null,
    ttlMs: ACCOUNT_LINK_TTL_MS,
  });
  const to = await sendWelcome(deps, payload.userId, {
    ...link,
    creatorName: payload.creatorName,
  });
  if (!to) throw new AppError("smtp_not_configured");
  return true;
}
