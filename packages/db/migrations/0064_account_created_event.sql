-- An administrator creating an account leaves its own entry on the
-- sign-in trail, with who created it.
ALTER TYPE "public"."auth_action" ADD VALUE IF NOT EXISTS 'account_created';
