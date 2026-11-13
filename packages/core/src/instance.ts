import { z } from "zod";

export const SIGNUP_POLICIES = ["open", "invite", "closed"] as const;
export type SignupPolicy = (typeof SIGNUP_POLICIES)[number];

/**
 * Who needs a second factor (ADR 0043). Administrators always do; the
 * default adds owners and anyone creating a base, as before.
 */
export const MFA_SCOPES = ["admins", "owners", "everyone"] as const;
export type MfaScope = (typeof MFA_SCOPES)[number];

/**
 * After single sign-on: AnyGridDB asks for its own second factor, or
 * trusts the identity provider's.
 */
export const SSO_MFA_MODES = ["local", "provider"] as const;
export type SsoMfaMode = (typeof SSO_MFA_MODES)[number];

/** Who may start a password reset: the person by email, or only an administrator. */
export const PASSWORD_RESET_MODES = ["self", "admin"] as const;
export type PasswordResetMode = (typeof PASSWORD_RESET_MODES)[number];

/** Public links to views and forms: allowed, only with a password, or off. */
export const PUBLIC_LINK_MODES = ["allowed", "password", "off"] as const;
export type PublicLinkMode = (typeof PUBLIC_LINK_MODES)[number];

/** Who may do something only some may (create a base, an API token). */
export const CREATOR_MODES = ["everyone", "admins"] as const;
export type CreatorMode = (typeof CREATOR_MODES)[number];

/** Whom owners may invite: any address, or only the sign-up domains'. */
export const INVITATION_MODES = ["anyone", "domains"] as const;
export type InvitationMode = (typeof INVITATION_MODES)[number];

/**
 * The bounds of each number an administrator sets. The lower bounds are
 * floors no setting crosses: brute force always meets a limit, a password
 * keeps 12 characters, the sign-in trail six months (CNIL).
 */
export const POLICY_BOUNDS = {
  lockoutThreshold: { min: 3, max: 20 },
  /** 0 keeps the account locked until an administrator unlocks it. */
  lockoutMinutes: { min: 5, max: 1440 },
  sessionIdleMinutes: { min: 5, max: 480 },
  sessionMaxHours: { min: 1, max: 168 },
  passwordMinLength: { min: 12, max: 64 },
  tokenMaxDays: { min: 1, max: 365 },
  authRetentionDays: { min: 180, max: 365 },
  /** 0 never disables an inactive account. */
  inactiveDays: { min: 30, max: 730 },
  /** How long deleted bases, tables, fields, and views can come back. */
  trashDays: { min: 7, max: 365 },
  alertBackupHours: { min: 6, max: 720 },
  alertStoragePercent: { min: 50, max: 99 },
  alertCertificateDays: { min: 1, max: 90 },
  alertFailures: { min: 1, max: 10_000 },
} as const;

/** An administrator is never locked out for good: the instance needs one. */
export const ADMIN_LOCK_MINUTES = 60;

const bounded = (key: keyof typeof POLICY_BOUNDS) =>
  z.int().min(POLICY_BOUNDS[key].min).max(POLICY_BOUNDS[key].max);

/** `example.org`, `mail.example.co.uk`: a host name, lower case. */
const domainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
  );

/**
 * An IPv4/IPv6 address or CIDR for the sign-in allowlist. Shape only; the
 * API checks the bits when it builds the list.
 */
const cidrSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(
    /^(?:\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-fA-F:]+\]|[0-9a-fA-F:]+)(?:\/\d{1,3})?$/,
  );

/** Default when neither the setting nor the environment sets a ceiling. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/** The largest ceiling an instance may choose, in the UI or the environment. */
export const ATTACHMENT_MAX_BYTES_CEILING = 500 * 1024 * 1024;

const fields = {
  signup: z.enum(SIGNUP_POLICIES),
  defaultLocale: z.enum(["fr", "en"]),
  /** Only administrators may work while it is on (ADR 0042). */
  maintenance: z.boolean(),
  /** A short announcement every signed-in person sees; null shows none. */
  banner: z.string().trim().max(500).nullable(),
  mfaScope: z.enum(MFA_SCOPES),
  ssoMfa: z.enum(SSO_MFA_MODES),
  /**
   * When true, only single sign-on opens a session for non-administrators.
   * Administrators keep a password as break-glass (ADR 0053).
   */
  ssoOnly: z.boolean(),
  /**
   * Client addresses that may open an interactive session. Empty means
   * any. API tokens, SCIM, and metrics stay out of this list.
   */
  signInAllowlist: z
    .array(cidrSchema)
    .max(50)
    .transform((entries) => [...new Set(entries)]),
  /** Failed passwords and codes in a row that lock an account. */
  lockoutThreshold: bounded("lockoutThreshold"),
  lockoutMinutes: z.union([z.literal(0), bounded("lockoutMinutes")]),
  sessionIdleMinutes: bounded("sessionIdleMinutes"),
  sessionMaxHours: bounded("sessionMaxHours"),
  passwordMinLength: bounded("passwordMinLength"),
  passwordReset: z.enum(PASSWORD_RESET_MODES),
  /** The longest an API token lives, the ones made before included. */
  tokenMaxDays: bounded("tokenMaxDays"),
  publicLinks: z.enum(PUBLIC_LINK_MODES),
  /** Addresses sign-up and SSO accept for a new account; empty means any. */
  signupDomains: z
    .array(domainSchema)
    .max(50)
    .transform((domains) => [...new Set(domains)]),
  authRetentionDays: bounded("authRetentionDays"),
  invitations: z.enum(INVITATION_MODES),
  baseCreation: z.enum(CREATOR_MODES),
  apiTokens: z.enum(CREATOR_MODES),
  /** Days without activity after which an account is disabled; 0 never. */
  inactiveDays: z.union([z.literal(0), bounded("inactiveDays")]),
  /** Tell administrators when an account locks (ADR 0044). */
  lockAlerts: z.boolean(),
  /**
   * Whether Administration may ask GitHub for a newer release (ADR 0048).
   * Off by default: the instance does not call home.
   */
  releaseCheck: z.boolean(),
  /**
   * Largest attachment in bytes (ADR 0050). Null keeps the environment
   * bootstrap, then the built-in 20 MiB default.
   */
  attachmentMaxBytes: z.union([
    z.null(),
    z.int().min(1024).max(ATTACHMENT_MAX_BYTES_CEILING),
  ]),
  /** Days the trash keeps what was deleted, before it is purged for good. */
  trashDays: bounded("trashDays"),
  /**
   * What administrators are told about (ROADMAP #25), each with its
   * threshold; 0 or false turns one off. Hours without a successful
   * backup, once backups are reported at all.
   */
  alertBackupHours: z.union([z.literal(0), bounded("alertBackupHours")]),
  /** Percent of the volume the files are on that is used. */
  alertStoragePercent: z.union([z.literal(0), bounded("alertStoragePercent")]),
  /** Days left before the instance's certificate expires. */
  alertCertificateDays: z.union([
    z.literal(0),
    bounded("alertCertificateDays"),
  ]),
  /** A source whose watched tables cannot be read. */
  alertSources: z.boolean(),
  /** Failed jobs, webhook deliveries, and automation runs in 24 hours. */
  alertFailures: z.union([z.literal(0), bounded("alertFailures")]),
};

export type InstanceSettings = {
  [Key in keyof typeof fields]: z.output<(typeof fields)[Key]>;
};

/** Simple, coherent choices an administrator may change (ADR 0043). */
export const INSTANCE_DEFAULTS: InstanceSettings = {
  signup: "open",
  defaultLocale: "en",
  maintenance: false,
  banner: null,
  mfaScope: "owners",
  ssoMfa: "local",
  ssoOnly: false,
  signInAllowlist: [],
  lockoutThreshold: 10,
  lockoutMinutes: 15,
  sessionIdleMinutes: 15,
  sessionMaxHours: 12,
  passwordMinLength: 12,
  passwordReset: "self",
  tokenMaxDays: 365,
  publicLinks: "allowed",
  signupDomains: [],
  authRetentionDays: 365,
  invitations: "anyone",
  baseCreation: "everyone",
  apiTokens: "everyone",
  inactiveDays: 0,
  lockAlerts: true,
  releaseCheck: false,
  attachmentMaxBytes: null,
  trashDays: 30,
  alertBackupHours: 36,
  alertStoragePercent: 90,
  alertCertificateDays: 14,
  alertSources: true,
  alertFailures: 50,
};

const KEYS = Object.keys(fields) as Array<keyof InstanceSettings>;

/** Instance settings with their defaults; unknown keys are dropped. */
export const instanceSettingsSchema = z.object({
  signup: fields.signup.default(INSTANCE_DEFAULTS.signup),
  defaultLocale: fields.defaultLocale.default(INSTANCE_DEFAULTS.defaultLocale),
  maintenance: fields.maintenance.default(INSTANCE_DEFAULTS.maintenance),
  banner: fields.banner.default(INSTANCE_DEFAULTS.banner),
  mfaScope: fields.mfaScope.default(INSTANCE_DEFAULTS.mfaScope),
  ssoMfa: fields.ssoMfa.default(INSTANCE_DEFAULTS.ssoMfa),
  ssoOnly: fields.ssoOnly.default(INSTANCE_DEFAULTS.ssoOnly),
  signInAllowlist: fields.signInAllowlist.default(
    INSTANCE_DEFAULTS.signInAllowlist,
  ),
  lockoutThreshold: fields.lockoutThreshold.default(
    INSTANCE_DEFAULTS.lockoutThreshold,
  ),
  lockoutMinutes: fields.lockoutMinutes.default(
    INSTANCE_DEFAULTS.lockoutMinutes,
  ),
  sessionIdleMinutes: fields.sessionIdleMinutes.default(
    INSTANCE_DEFAULTS.sessionIdleMinutes,
  ),
  sessionMaxHours: fields.sessionMaxHours.default(
    INSTANCE_DEFAULTS.sessionMaxHours,
  ),
  passwordMinLength: fields.passwordMinLength.default(
    INSTANCE_DEFAULTS.passwordMinLength,
  ),
  passwordReset: fields.passwordReset.default(INSTANCE_DEFAULTS.passwordReset),
  tokenMaxDays: fields.tokenMaxDays.default(INSTANCE_DEFAULTS.tokenMaxDays),
  publicLinks: fields.publicLinks.default(INSTANCE_DEFAULTS.publicLinks),
  signupDomains: fields.signupDomains.default(INSTANCE_DEFAULTS.signupDomains),
  authRetentionDays: fields.authRetentionDays.default(
    INSTANCE_DEFAULTS.authRetentionDays,
  ),
  invitations: fields.invitations.default(INSTANCE_DEFAULTS.invitations),
  baseCreation: fields.baseCreation.default(INSTANCE_DEFAULTS.baseCreation),
  apiTokens: fields.apiTokens.default(INSTANCE_DEFAULTS.apiTokens),
  inactiveDays: fields.inactiveDays.default(INSTANCE_DEFAULTS.inactiveDays),
  lockAlerts: fields.lockAlerts.default(INSTANCE_DEFAULTS.lockAlerts),
  releaseCheck: fields.releaseCheck.default(INSTANCE_DEFAULTS.releaseCheck),
  attachmentMaxBytes: fields.attachmentMaxBytes.default(
    INSTANCE_DEFAULTS.attachmentMaxBytes,
  ),
  trashDays: fields.trashDays.default(INSTANCE_DEFAULTS.trashDays),
  alertBackupHours: fields.alertBackupHours.default(
    INSTANCE_DEFAULTS.alertBackupHours,
  ),
  alertStoragePercent: fields.alertStoragePercent.default(
    INSTANCE_DEFAULTS.alertStoragePercent,
  ),
  alertCertificateDays: fields.alertCertificateDays.default(
    INSTANCE_DEFAULTS.alertCertificateDays,
  ),
  alertSources: fields.alertSources.default(INSTANCE_DEFAULTS.alertSources),
  alertFailures: fields.alertFailures.default(INSTANCE_DEFAULTS.alertFailures),
});

export const instanceSettingsPatchSchema = z
  .object({
    signup: fields.signup.optional(),
    defaultLocale: fields.defaultLocale.optional(),
    maintenance: fields.maintenance.optional(),
    banner: fields.banner.optional(),
    mfaScope: fields.mfaScope.optional(),
    ssoMfa: fields.ssoMfa.optional(),
    ssoOnly: fields.ssoOnly.optional(),
    signInAllowlist: fields.signInAllowlist.optional(),
    lockoutThreshold: fields.lockoutThreshold.optional(),
    lockoutMinutes: fields.lockoutMinutes.optional(),
    sessionIdleMinutes: fields.sessionIdleMinutes.optional(),
    sessionMaxHours: fields.sessionMaxHours.optional(),
    passwordMinLength: fields.passwordMinLength.optional(),
    passwordReset: fields.passwordReset.optional(),
    tokenMaxDays: fields.tokenMaxDays.optional(),
    publicLinks: fields.publicLinks.optional(),
    signupDomains: fields.signupDomains.optional(),
    authRetentionDays: fields.authRetentionDays.optional(),
    invitations: fields.invitations.optional(),
    baseCreation: fields.baseCreation.optional(),
    apiTokens: fields.apiTokens.optional(),
    inactiveDays: fields.inactiveDays.optional(),
    lockAlerts: fields.lockAlerts.optional(),
    releaseCheck: fields.releaseCheck.optional(),
    attachmentMaxBytes: fields.attachmentMaxBytes.optional(),
    trashDays: fields.trashDays.optional(),
    alertBackupHours: fields.alertBackupHours.optional(),
    alertStoragePercent: fields.alertStoragePercent.optional(),
    alertCertificateDays: fields.alertCertificateDays.optional(),
    alertSources: fields.alertSources.optional(),
    alertFailures: fields.alertFailures.optional(),
  })
  .strict();

export type InstanceSettingsPatch = z.infer<typeof instanceSettingsPatchSchema>;

/**
 * The stored settings, key by key: a value that no longer fits (a bound
 * moved) falls back to its own default, never the others. An instance
 * that required a second factor of everyone (`requireMfa`) keeps it.
 */
export function parseInstanceSettings(
  raw: Readonly<Record<string, unknown>>,
): InstanceSettings {
  const source: Record<string, unknown> = { ...raw };
  if (source.mfaScope === undefined && source.requireMfa === true) {
    source.mfaScope = "everyone";
  }
  const settings = { ...INSTANCE_DEFAULTS } as Record<string, unknown>;
  for (const key of KEYS) {
    if (source[key] === undefined) continue;
    const parsed = fields[key].safeParse(source[key]);
    if (parsed.success) settings[key] = parsed.data;
  }
  return settings as InstanceSettings;
}

/**
 * UI setting when set, else environment bootstrap, else 20 MiB (ADR 0050).
 */
export function resolveAttachmentMaxBytes(
  settings: Pick<InstanceSettings, "attachmentMaxBytes">,
  envBytes?: number,
  fallback: number = DEFAULT_ATTACHMENT_MAX_BYTES,
): number {
  if (settings.attachmentMaxBytes != null) return settings.attachmentMaxBytes;
  return envBytes ?? fallback;
}

/** `ADMIN_EMAILS`: a comma or space separated list, compared in lower case. */
export function parseAdminEmails(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map((item) => item.trim().toLowerCase())
      .filter((item) => item.includes("@")),
  );
}

/**
 * Whether a new account may be created. The very first account always
 * may, so an instance can be set up; afterwards the policy decides, and
 * "invite" needs a pending invitation for that email.
 */
export function signupAllowed(
  policy: SignupPolicy,
  context: { firstAccount: boolean; invited: boolean },
): boolean {
  if (context.firstAccount) return true;
  if (policy === "open") return true;
  if (policy === "invite") return context.invited;
  return false;
}

/** Whether an address belongs to one of the domains; an empty list takes any. */
export function emailDomainAllowed(
  email: string,
  domains: readonly string[],
): boolean {
  if (domains.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return domains.includes(domain);
}

/**
 * Whether owners may give a role to this address (ADR 0044): any, unless
 * invitations keep to the sign-up domains and some are set.
 */
export function memberDomainAllowed(
  email: string,
  policy: Pick<InstanceSettings, "invitations" | "signupDomains">,
): boolean {
  return (
    policy.invitations !== "domains" ||
    emailDomainAllowed(email, policy.signupDomains)
  );
}

/**
 * When an inactive account is warned, and when it is disabled, counted
 * from its last activity: a week before, or a quarter of the delay when
 * that is shorter. Null when the instance never disables one.
 */
export function inactivityDates(
  activeAt: Date,
  policy: Pick<InstanceSettings, "inactiveDays">,
): { warnAt: Date; disableAt: Date } | null {
  if (policy.inactiveDays === 0) return null;
  const day = 86_400_000;
  const disableAt = new Date(activeAt.getTime() + policy.inactiveDays * day);
  const before = Math.min(7, Math.floor(policy.inactiveDays / 4));
  return { warnAt: new Date(disableAt.getTime() - before * day), disableAt };
}

/**
 * Whether an account locked at `lockedAt` is still locked, and until
 * when; `until: null` means until an administrator unlocks it.
 */
export function lockState(
  lockedAt: Date | null,
  policy: Pick<InstanceSettings, "lockoutMinutes">,
  isAdmin: boolean,
  now: Date = new Date(),
): { locked: false } | { locked: true; until: Date | null } {
  if (!lockedAt) return { locked: false };
  const minutes =
    policy.lockoutMinutes === 0 && isAdmin
      ? ADMIN_LOCK_MINUTES
      : policy.lockoutMinutes;
  if (minutes === 0) return { locked: true, until: null };
  const until = new Date(lockedAt.getTime() + minutes * 60_000);
  return until > now ? { locked: true, until } : { locked: false };
}

/** A session's idle window and its absolute lifetime, in milliseconds. */
export function sessionWindows(
  policy: Pick<InstanceSettings, "sessionIdleMinutes" | "sessionMaxHours">,
): { idleMs: number; maxMs: number } {
  const maxMs = policy.sessionMaxHours * 3_600_000;
  return { idleMs: Math.min(policy.sessionIdleMinutes * 60_000, maxMs), maxMs };
}
