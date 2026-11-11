-- Operator mail (ADR 0052): an administrator may send a plain-text notice
-- to every active account or to accounts they choose. The sign-in trail
-- records the send (never an address or the body).
ALTER TYPE "public"."auth_action" ADD VALUE 'operator_mail_sent';
