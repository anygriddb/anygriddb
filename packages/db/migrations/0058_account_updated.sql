-- The sign-in trail records that an administrator corrected an account's
-- name or address.
ALTER TYPE "public"."auth_action" ADD VALUE 'account_updated';
