/**
 * What the instance keeps sealed, counted by the key that sealed it, and
 * sealed again under the current key (ADR 0066). An operator who changes
 * AUTH_ENCRYPTION_KEY keeps the earlier key in AUTH_ENCRYPTION_PREVIOUS_KEYS
 * until this has rewritten everything it sealed.
 *
 * Left as they are, on purpose: a sign-in in flight and a queued job's
 * token, which live minutes, and backup codes, which are hashes: they
 * match while the key that hashed them is kept, and are made anew by
 * their owner.
 */
import { readdir } from "node:fs/promises";
import type { Database } from "@anygriddb/db";
import { sql } from "kysely";
import { resealTlsKey } from "../tls/authority.js";
import { encryptSecret, openSecret } from "./crypto.js";
import type { KeyRing, KeyUse } from "./key-ring.js";

/** Where a sealed value is kept: its table, its row's key, its two columns. */
type SealedColumn = {
  table: string;
  id: string;
  use: KeyUse;
  ciphertext: string;
  nonce: string;
};

const SEALED_COLUMNS: readonly SealedColumn[] = [
  {
    table: "totp_secrets",
    id: "user_id",
    use: "totp",
    ciphertext: "ciphertext",
    nonce: "nonce",
  },
  {
    table: "instance_smtp",
    id: "id",
    use: "smtp",
    ciphertext: "password_ciphertext",
    nonce: "password_nonce",
  },
  {
    table: "instance_oidc",
    id: "id",
    use: "oidc",
    ciphertext: "client_secret_ciphertext",
    nonce: "client_secret_nonce",
  },
  {
    table: "instance_siem",
    id: "id",
    use: "siem",
    ciphertext: "secret_ciphertext",
    nonce: "secret_nonce",
  },
  {
    table: "webhooks",
    id: "id",
    use: "webhook",
    ciphertext: "secret_ciphertext",
    nonce: "secret_nonce",
  },
  {
    table: "webhooks",
    id: "id",
    use: "webhook",
    ciphertext: "headers_ciphertext",
    nonce: "headers_nonce",
  },
  {
    table: "sources",
    id: "id",
    use: "source",
    ciphertext: "password_ciphertext",
    nonce: "password_nonce",
  },
  {
    table: "sources",
    id: "id",
    use: "source",
    ciphertext: "replica_password_ciphertext",
    nonce: "replica_password_nonce",
  },
];

/** The name a value sealed before keys had identifiers is counted under. */
export const BEFORE_KEY_IDS = "before key identifiers";

const PAGE = 500;

export type KeyRotation = {
  /** How many sealed values each key holds, by its identifier. */
  byKey: Record<string, number>;
  /** Values sealed again under the current key by this run. */
  rewritten: number;
  /** Values no key of the ring opens, named by where they are, never shown. */
  unreadable: string[];
  /**
   * Key files of the certificates folder that belong to another account
   * than the one asking: neither counted nor rewritten.
   */
  forbidden: string[];
};

function count(report: KeyRotation, keyId: string | null): void {
  const name = keyId ?? BEFORE_KEY_IDS;
  report.byKey[name] = (report.byKey[name] ?? 0) + 1;
}

async function rotateColumn(
  db: Database,
  ring: KeyRing,
  column: SealedColumn,
  write: boolean,
  report: KeyRotation,
): Promise<void> {
  const table = sql.table(column.table);
  const id = sql.ref(column.id);
  const ciphertext = sql.ref(column.ciphertext);
  const nonce = sql.ref(column.nonce);
  let after = "";
  for (;;) {
    const page = await sql<{ id: string; ciphertext: Buffer; nonce: Buffer }>`
      select ${id}::text as "id", ${ciphertext} as "ciphertext", ${nonce} as "nonce"
        from ${table}
       where ${ciphertext} is not null and ${nonce} is not null
         and ${id}::text > ${after}
       order by ${id}::text
       limit ${PAGE}
    `.execute(db);
    for (const row of page.rows) {
      let opened: ReturnType<typeof openSecret>;
      try {
        opened = openSecret(row.ciphertext, row.nonce, ring, column.use);
      } catch {
        report.unreadable.push(
          `${column.table}.${column.ciphertext} ${row.id}`,
        );
        continue;
      }
      if (opened.keyId === ring.currentId || !write) {
        count(report, opened.keyId);
        continue;
      }
      const sealed = encryptSecret(opened.plaintext, ring, column.use);
      // Only if it is still the value that was read: one changed since by
      // the running instance is already under the current key.
      await sql`
        update ${table}
           set ${ciphertext} = ${sealed.ciphertext}, ${nonce} = ${sealed.nonce}
         where ${id}::text = ${row.id} and ${ciphertext} = ${row.ciphertext}
      `.execute(db);
      count(report, ring.currentId);
      report.rewritten += 1;
    }
    const last = page.rows.at(-1);
    if (page.rows.length < PAGE || !last) return;
    after = last.id;
  }
}

/**
 * Counts every sealed value by the key that sealed it and, with `write`,
 * seals again under the current key what an earlier one sealed. Safe to
 * run again, and beside the running instance.
 */
export async function rotateKeys(
  db: Database,
  ring: KeyRing,
  options: { write: boolean; tlsDir?: string },
): Promise<KeyRotation> {
  const report: KeyRotation = {
    byKey: {},
    rewritten: 0,
    unreadable: [],
    forbidden: [],
  };
  for (const column of SEALED_COLUMNS) {
    await rotateColumn(db, ring, column, options.write, report);
  }
  if (options.tlsDir) {
    const names = await readdir(options.tlsDir).catch(() => []);
    for (const name of names.filter((item) => item.endsWith(".key.enc"))) {
      const outcome = await resealTlsKey(
        options.tlsDir,
        name,
        ring,
        options.write,
      );
      if (outcome === "forbidden") {
        report.forbidden.push(name);
        continue;
      }
      if (outcome === "unreadable") {
        report.unreadable.push(`${name} in the certificates folder`);
        continue;
      }
      count(report, outcome.keyId);
      if (outcome.rewritten) report.rewritten += 1;
    }
  }
  return report;
}
