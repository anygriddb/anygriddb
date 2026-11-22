-- A SAML assertion does not say whether its address was verified. A first
-- sign-in reaches an existing account by that address only once an
-- administrator says this provider verifies it (ADR 0111).
ALTER TABLE "instance_saml"
  ADD COLUMN "trusts_addresses" boolean NOT NULL DEFAULT false;
