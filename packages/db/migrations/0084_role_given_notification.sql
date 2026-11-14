-- A base's owners are told of every role an administrator gives on it
-- (ROADMAP #91): to a person, to several from a file, to a group, or to
-- someone added to a group that holds one.
ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'role_given';
