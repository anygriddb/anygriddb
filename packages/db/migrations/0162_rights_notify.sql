-- ADR 0131: every change of who may read what tells each process's open
-- sockets to ask again, by the database itself, whichever way it came: a
-- call of the application, the identity provider (SCIM), the
-- administration API, a job, or a role whose end came (ADR 0146). The
-- message is the one the realtime bus carries on its channel ("rights"),
-- sent at commit; one statement sends one, and PostgreSQL folds the same
-- message sent twice in a transaction.
CREATE FUNCTION "ag_rights_changed"() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_notify(
    'anygriddb_realtime',
    '{"c":"rights","m":"{\"type\":\"rights\"}"}'
  );
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "attributions_rights_changed"
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "attributions"
  FOR EACH STATEMENT EXECUTE FUNCTION "ag_rights_changed"();--> statement-breakpoint
CREATE TRIGGER "group_members_rights_changed"
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "group_members"
  FOR EACH STATEMENT EXECUTE FUNCTION "ag_rights_changed"();--> statement-breakpoint
CREATE TRIGGER "groups_rights_changed"
  AFTER DELETE OR TRUNCATE ON "groups"
  FOR EACH STATEMENT EXECUTE FUNCTION "ag_rights_changed"();--> statement-breakpoint
CREATE TRIGGER "made_roles_rights_changed"
  AFTER UPDATE OR DELETE OR TRUNCATE ON "made_roles"
  FOR EACH STATEMENT EXECUTE FUNCTION "ag_rights_changed"();--> statement-breakpoint
CREATE TRIGGER "account_attributes_rights_changed"
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "account_attributes"
  FOR EACH STATEMENT EXECUTE FUNCTION "ag_rights_changed"();--> statement-breakpoint
CREATE TRIGGER "person_attributes_rights_changed"
  AFTER DELETE OR TRUNCATE ON "person_attributes"
  FOR EACH STATEMENT EXECUTE FUNCTION "ag_rights_changed"();--> statement-breakpoint
CREATE TRIGGER "emergency_access_rights_changed"
  AFTER INSERT OR UPDATE OR DELETE OR TRUNCATE ON "emergency_access"
  FOR EACH STATEMENT EXECUTE FUNCTION "ag_rights_changed"();--> statement-breakpoint
-- An account turned off or on, or erased, reads nothing more, or again.
CREATE TRIGGER "users_rights_changed"
  AFTER UPDATE OF "disabled_at" OR DELETE ON "users"
  FOR EACH STATEMENT EXECUTE FUNCTION "ag_rights_changed"();
