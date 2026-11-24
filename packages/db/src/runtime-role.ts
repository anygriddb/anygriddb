import type pg from "pg";

/** What keeps a record: the application adds to it and rewrites nothing. */
const TRAILS = [
  "audit_events",
  "row_signatures",
  "external_writes",
  "external_write_steps",
  "external_status_events",
] as const;

/**
 * What the row trigger takes its rules from (a table's status circuit, ADR
 * 0124): the application reads it, and changes it only through the owner's
 * `ag_replace_status_circuit`, which keeps a sealed row sealed.
 */
const RULES = [
  "status_circuits",
  "status_states",
  "status_transitions",
  "status_transition_grants",
] as const;

const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * What the role the application signs in as may do (ADR 0119). It owns no
 * table: it reads and writes rows, adds to the trails, and changes a
 * table's structure only through the owner's functions. Run by the owner
 * at each start, after the migrations: a restored dump carries no rights.
 */
export async function grantRuntimeRole(
  client: Pick<pg.PoolClient, "query">,
  role: string,
): Promise<void> {
  if (!ROLE_NAME.test(role)) throw new Error("invalid role name");
  const owns = await client.query<{ owns: boolean }>(
    "select ag_role_owns_store($1::name) as owns",
    [role],
  );
  if (owns.rows[0]?.owns) {
    throw new Error(
      `${role} owns the tables: it cannot be the role that does not`,
    );
  }
  const who = `"${role}"`;
  const statements = [
    `grant usage on schema public to ${who}`,
    `grant select, insert, update, delete on all tables in schema public to ${who}`,
    `grant usage, select on all sequences in schema public to ${who}`,
    `grant execute on all functions in schema public to ${who}`,
    `alter default privileges in schema public grant select, insert, update, delete on tables to ${who}`,
    `alter default privileges in schema public grant usage, select on sequences to ${who}`,
    ...TRAILS.map(
      (table) => `revoke update, delete, truncate on "${table}" from ${who}`,
    ),
    ...RULES.map(
      (table) =>
        `revoke insert, update, delete, truncate on "${table}" from ${who}`,
    ),
    `revoke update, truncate on "auth_events" from ${who}`,
    `revoke insert, update, delete, truncate on "schema_migrations" from ${who}`,
    `grant usage on schema graphile_worker to ${who}`,
    `grant all on all tables in schema graphile_worker to ${who}`,
    `grant all on all sequences in schema graphile_worker to ${who}`,
    `grant execute on all functions in schema graphile_worker to ${who}`,
    `grant usage, create on schema ag_sync to ${who}`,
  ];
  for (const statement of statements) await client.query(statement);
  // The copies of clients' tables hold no trail: they are the role's own,
  // which it makes, swaps and drops at each refresh.
  const copies = await client.query<{ name: string }>(
    `select c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'ag_sync' and c.relkind = 'r'
        and pg_get_userbyid(c.relowner) <> $1`,
    [role],
  );
  for (const { name } of copies.rows) {
    await client.query(`alter table ag_sync."${name}" owner to ${who}`);
  }
  // The queue's library turns row security on for its tables and writes no
  // policy, which leaves them to their owner alone.
  const { rows } = await client.query<{ name: string }>(
    `select c.relname as name from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'graphile_worker' and c.relkind = 'r' and c.relrowsecurity
        and not exists (
          select 1 from pg_policy p
           where p.polrelid = c.oid and p.polname = 'ag_runtime'
        )`,
  );
  for (const { name } of rows) {
    await client.query(
      `create policy ag_runtime on graphile_worker."${name}" to ${who} using (true) with check (true)`,
    );
  }
}
