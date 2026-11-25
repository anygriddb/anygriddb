-- A token's way in is a permission of its own (`api.access`): the REST
-- API, MCP and the applications given access reach a base or a table only
-- through a role that gives it. Each of the four roles gives it, so nobody
-- holding one of them loses anything. A permission a version adds goes to
-- no role an administrator made: theirs reach nothing by a token until
-- they are given it.
ALTER TABLE "made_roles" DROP CONSTRAINT "made_roles_permissions_check";
ALTER TABLE "made_roles" ADD CONSTRAINT "made_roles_permissions_check" CHECK (
  jsonb_typeof("permissions") = 'array'
  AND "permissions" @> '["rows.read"]'::jsonb
  AND "permissions" <@ '[
    "rows.read", "rows.comment", "rows.write", "rows.delete", "rows.lock",
    "data.export", "api.access", "data.import", "publish", "views.manage",
    "dashboards.manage", "schema.manage", "automations.manage",
    "webhooks.manage", "members.manage", "base.manage"
  ]'::jsonb
);
