-- What the conversion to attributions (ADR 0131) will not keep exactly,
-- read with the version before it: one row per person and base, or per
-- person and table, with the case of the ADR's table and the permissions it
-- moves. Administration › People › Rights to review lists it, and the
-- conversion's check counts it.
--
-- It reads access as this version decides it: a role on a table replaces
-- the base's there, a group gives a role on a base to each of its members
-- (the copies in `role_bindings`), and a field or row rule binds whoever
-- does not hold `members.manage` on its table. After the conversion roles
-- add up: nothing given on a table takes away what the base gives.
--
-- Per person and base, one treatment, in this order:
--   keep   the person manages the base (`base.manage` or `members.manage`),
--          or a group gives them a role there that a table's role or a rule
--          narrows: the base's roles stay, and every table they were narrowed
--          on widens to them (`manager`, case b; `group`, case e; the
--          permissions are what the table gains);
--   ruled  a rule binds them on a table: the base's role goes, and each
--          table of the base gives exactly what it gave, the ruled ones with
--          their rule (`ruled`, case d);
--   lower  a table's role narrows the base's: the base's role falls to what
--          it shares with every such table, and each table gives back
--          exactly what it gave (`floor`, case c; the permissions are the
--          floor).
-- `base_only` (case f) is what `ruled` and `lower` lose at the base, where
-- only the base is asked (tables and folders, dashboards, a workbook
-- imported, a link published); `idle_rule` (case g) a rule that binds
-- nobody, dropped. Trashed tables and bases count: a restore gives back
-- what was held.
CREATE OR REPLACE FUNCTION ag_rights_review()
RETURNS TABLE (
  user_id uuid,
  base_id uuid,
  table_id uuid,
  kind text,
  permissions text[]
)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
  WITH packs (role, perms) AS (
    VALUES
      ('viewer', ARRAY['rows.read', 'data.export', 'api.access']),
      ('commenter', ARRAY['rows.read', 'data.export', 'api.access',
        'rows.comment']),
      ('editor', ARRAY['rows.read', 'data.export', 'api.access',
        'rows.comment', 'rows.write', 'rows.transition', 'rows.delete',
        'data.import', 'publish', 'views.manage']),
      ('owner', ARRAY['rows.read', 'rows.comment', 'rows.write',
        'rows.delete', 'rows.lock', 'rows.transition', 'data.export',
        'api.access', 'data.import', 'publish', 'views.manage',
        'dashboards.manage', 'schema.manage', 'automations.manage',
        'webhooks.manage', 'members.manage', 'base.manage'])
  ),
  given AS (
    SELECT b.user_id, b.scope::text AS scope, b.scope_id,
      b.group_id IS NOT NULL AS by_group, x.permission
    FROM role_bindings b
    LEFT JOIN packs p ON p.role = b.role::text
    LEFT JOIN made_roles m ON m.id = b.made_role_id
    CROSS JOIN LATERAL (
      SELECT unnest(p.perms)
      UNION
      SELECT jsonb_array_elements_text(m.permissions)
    ) AS x (permission)
    WHERE b.scope::text IN ('base', 'table')
  ),
  on_base AS (
    SELECT g.user_id, g.scope_id AS base_id,
      array_agg(DISTINCT g.permission) AS held,
      coalesce(array_agg(DISTINCT g.permission) FILTER (WHERE NOT g.by_group),
        '{}') AS direct,
      coalesce(array_agg(DISTINCT g.permission) FILTER (WHERE g.by_group),
        '{}') AS by_groups
    FROM given g
    WHERE g.scope = 'base'
    GROUP BY g.user_id, g.scope_id
  ),
  on_table AS (
    SELECT g.user_id, g.scope_id AS table_id,
      array_agg(DISTINCT g.permission) AS held
    FROM given g
    WHERE g.scope = 'table'
    GROUP BY g.user_id, g.scope_id
  ),
  ruled AS (
    SELECT a.user_id, a.table_id FROM table_acls a
    WHERE a.row_filter IS NOT NULL
    UNION
    SELECT c.user_id, c.table_id FROM column_acls c
  ),
  reach AS (
    SELECT r.user_id, t.id AS table_id, t.base_id
    FROM (
      SELECT ob.user_id, bt.id AS table_id
      FROM on_base ob JOIN data_tables bt ON bt.base_id = ob.base_id
      UNION
      SELECT ot.user_id, ot.table_id FROM on_table ot
      UNION
      SELECT ru.user_id, ru.table_id FROM ruled ru
    ) AS r
    JOIN data_tables t ON t.id = r.table_id
  ),
  cell AS (
    SELECT r.user_id, r.base_id, r.table_id,
      ob.held AS base_held,
      coalesce(ob.direct, '{}') AS direct,
      coalesce(ob.by_groups, '{}') AS by_groups,
      ot.held AS table_held,
      coalesce(ot.held, ob.held) AS held,
      EXISTS (
        SELECT 1 FROM ruled ru
        WHERE ru.user_id = r.user_id AND ru.table_id = r.table_id
      ) AS has_rule
    FROM reach r
    LEFT JOIN on_base ob
      ON ob.user_id = r.user_id AND ob.base_id = r.base_id
    LEFT JOIN on_table ot
      ON ot.user_id = r.user_id AND ot.table_id = r.table_id
  ),
  judged AS (
    SELECT c.*,
      coalesce(c.table_held IS NOT NULL AND c.base_held IS NOT NULL
        AND NOT c.table_held @> c.base_held, false) AS narrowed,
      coalesce(c.has_rule AND c.held IS NOT NULL
        AND NOT 'members.manage' = ANY (c.held), false) AS binds,
      coalesce(c.has_rule AND (c.held IS NULL
        OR 'members.manage' = ANY (c.held)), false) AS idle_rule
    FROM cell c
  ),
  marked AS (
    SELECT j.*,
      j.narrowed OR j.binds AS narrows,
      cardinality(j.by_groups) > 0 AND (j.binds
        OR (j.narrowed AND NOT j.table_held @> j.by_groups)) AS under_group
    FROM judged j
  ),
  per_base AS (
    SELECT m.user_id, m.base_id,
      bool_or(m.narrows) AS narrows,
      bool_or(m.binds) AS binds,
      bool_or(m.under_group) AS under_group,
      bool_or(m.base_held IS NOT NULL) AS has_base,
      coalesce(bool_or(m.base_held && ARRAY['base.manage', 'members.manage']),
        false) AS manages
    FROM marked m
    GROUP BY m.user_id, m.base_id
  ),
  treated AS (
    SELECT pb.*,
      CASE
        -- With roles on tables alone, nothing narrows: a rule goes with
        -- the table's attribution, as it is.
        WHEN NOT pb.narrows OR NOT pb.has_base THEN 'none'
        WHEN pb.manages OR pb.under_group THEN 'keep'
        WHEN pb.binds THEN 'ruled'
        ELSE 'lower'
      END AS treatment,
      ob.held AS base_held,
      coalesce(ob.direct, '{}') AS direct,
      coalesce(ob.by_groups, '{}') AS by_groups
    FROM per_base pb
    LEFT JOIN on_base ob
      ON ob.user_id = pb.user_id AND ob.base_id = pb.base_id
  ),
  floors AS (
    SELECT t.user_id, t.base_id, t.base_held, t.by_groups,
      ARRAY(
        SELECT p FROM unnest(t.direct) AS p
        WHERE NOT EXISTS (
          SELECT 1 FROM marked m
          WHERE m.user_id = t.user_id AND m.base_id = t.base_id
            AND m.narrowed AND NOT p = ANY (m.table_held)
        )
        ORDER BY p
      ) AS floor
    FROM treated t
    WHERE t.treatment = 'lower'
  ),
  base_only (permission) AS (
    VALUES ('schema.manage'), ('dashboards.manage'), ('data.import'),
      ('publish')
  )
  -- keep: each table narrowed or ruled widens.
  SELECT m.user_id, m.base_id, m.table_id,
    CASE WHEN t.manages AND NOT m.under_group THEN 'manager' ELSE 'group' END,
    ARRAY(
      SELECT p FROM unnest(m.base_held) AS p
      WHERE NOT p = ANY (m.held)
      ORDER BY p
    )
  FROM marked m
  JOIN treated t ON t.user_id = m.user_id AND t.base_id = m.base_id
  WHERE t.treatment = 'keep' AND m.narrows
  UNION ALL
  -- ruled: the base's role goes, each table keeps what it gave.
  SELECT t.user_id, t.base_id, NULL, 'ruled', NULL
  FROM treated t
  WHERE t.treatment = 'ruled'
  UNION ALL
  -- lower: the base falls to the floor.
  SELECT f.user_id, f.base_id, NULL, 'floor', f.floor
  FROM floors f
  UNION ALL
  -- What ruled and lower lose where only the base is asked.
  SELECT lost.user_id, lost.base_id, NULL, 'base_only', lost.perms
  FROM (
    SELECT t.user_id, t.base_id,
      ARRAY(
        SELECT o.permission FROM base_only o
        WHERE o.permission = ANY (t.base_held)
          AND NOT o.permission = ANY (t.by_groups)
          AND NOT o.permission = ANY (coalesce(f.floor, '{}'))
        ORDER BY o.permission
      ) AS perms
    FROM treated t
    LEFT JOIN floors f ON f.user_id = t.user_id AND f.base_id = t.base_id
    WHERE t.treatment IN ('ruled', 'lower')
  ) AS lost
  WHERE cardinality(lost.perms) > 0
  UNION ALL
  -- A rule that binds nobody.
  SELECT m.user_id, m.base_id, m.table_id, 'idle_rule', NULL
  FROM marked m
  WHERE m.idle_rule
$$;
