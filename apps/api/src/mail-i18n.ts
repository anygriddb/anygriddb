import { WEBHOOK_FAILURE_LIMIT, type InstanceSettings } from "@anygriddb/core";
import type { NotificationKind } from "./notifications.js";

export type MailLocale = "en" | "fr";

/** User preference when present, else the instance default, else English. */
export function resolveLocale(
  userPreference?: MailLocale | null,
  instanceDefault?: InstanceSettings["defaultLocale"] | null,
): MailLocale {
  if (userPreference === "en" || userPreference === "fr") {
    return userPreference;
  }
  if (instanceDefault === "en" || instanceDefault === "fr") {
    return instanceDefault;
  }
  return "en";
}

function tableQuoted(locale: MailLocale, tableName: string): string {
  if (locale === "fr") {
    return `«\u00a0${tableName}\u00a0»`;
  }
  return `"${tableName}"`;
}

const NOTIFICATION_SUBJECTS: Record<
  MailLocale,
  Record<NotificationKind, (tableName: string) => string>
> = {
  en: {
    mention: (table) => `You were mentioned in ${tableQuoted("en", table)}`,
    reply: (table) => `New reply in ${tableQuoted("en", table)}`,
    assigned: (table) =>
      `A row was assigned to you in ${tableQuoted("en", table)}`,
    automation: (table) => `Automation in ${tableQuoted("en", table)}`,
    webhook_disabled: (table) =>
      `Webhook disabled on ${tableQuoted("en", table)}`,
    row_changed: (table) =>
      `A locked row in ${tableQuoted("en", table)} changed outside AnyGridDB`,
  },
  fr: {
    mention: (table) =>
      `Vous avez été mentionné dans ${tableQuoted("fr", table)}`,
    reply: (table) => `Nouvelle réponse dans ${tableQuoted("fr", table)}`,
    assigned: (table) =>
      `Une ligne vous a été assignée dans ${tableQuoted("fr", table)}`,
    automation: (table) => `Automatisation dans ${tableQuoted("fr", table)}`,
    webhook_disabled: (table) =>
      `Webhook désactivé sur ${tableQuoted("fr", table)}`,
    row_changed: (table) =>
      `Une ligne verrouillée de ${tableQuoted("fr", table)} a changé hors d’AnyGridDB`,
  },
};

const NOTIFICATION_FOOTER: Record<MailLocale, string> = {
  en: "You receive this email because email notifications are enabled in your settings.",
  fr: "Vous recevez cet email car les notifications par email sont activées dans vos réglages.",
};

const MAIL_PREFIX = "AnyGridDB";

export function notificationSubject(
  locale: MailLocale,
  kind: NotificationKind,
  tableName: string,
): string {
  return NOTIFICATION_SUBJECTS[locale][kind](tableName);
}

export function notificationMailSubject(
  locale: MailLocale,
  kind: NotificationKind,
  tableName: string,
): string {
  const separator = locale === "fr" ? "\u00a0: " : ": ";
  return `${MAIL_PREFIX}${separator}${notificationSubject(locale, kind, tableName)}`;
}

export function notificationMailBody(
  locale: MailLocale,
  kind: NotificationKind,
  tableName: string,
  link: string,
): string {
  const subject = notificationSubject(locale, kind, tableName);
  return `${subject}.\n\n${link}\n\n${NOTIFICATION_FOOTER[locale]}`;
}

export function invitationMailSubject(
  locale: MailLocale,
  baseName: string,
): string {
  const quoted = tableQuoted(locale, baseName);
  return locale === "fr"
    ? `${MAIL_PREFIX}\u00a0: invitation à ${quoted}`
    : `${MAIL_PREFIX}: invitation to ${quoted}`;
}

export function invitationMailBody(
  locale: MailLocale,
  input: {
    inviterName: string;
    link: string;
    expiresDate: string;
  },
): string {
  if (locale === "fr") {
    return `${input.inviterName} vous invite sur AnyGridDB.\n\n${input.link}\n\nLe lien expire le ${input.expiresDate}.`;
  }
  return `${input.inviterName} invited you to AnyGridDB.\n\n${input.link}\n\nThe link expires on ${input.expiresDate}.`;
}

export function testMailSubject(locale: MailLocale): string {
  return locale === "fr"
    ? `${MAIL_PREFIX}\u00a0: message de test`
    : `${MAIL_PREFIX}: test message`;
}

export function testMailBody(locale: MailLocale): string {
  return locale === "fr"
    ? "Ce message confirme que cette instance envoie bien ses emails."
    : "This message confirms that this instance can send email.";
}

/** Fixed footer on an administrator's notice to accounts (ADR 0052). */
export function operatorMailFooter(locale: MailLocale): string {
  return locale === "fr"
    ? "Ce message a été envoyé par un administrateur de votre instance AnyGridDB."
    : "This message was sent by an administrator of your AnyGridDB instance.";
}

export function operatorMailText(locale: MailLocale, body: string): string {
  return `${body.trimEnd()}\n\n—\n${operatorMailFooter(locale)}`;
}

export function webhookDisabledMailSubject(locale: MailLocale): string {
  return locale === "fr"
    ? `${MAIL_PREFIX}\u00a0: webhook désactivé`
    : `${MAIL_PREFIX}: webhook disabled`;
}

export function webhookDisabledMailBody(
  locale: MailLocale,
  webhookName: string,
): string {
  const limit = WEBHOOK_FAILURE_LIMIT;
  if (locale === "fr") {
    const quoted = tableQuoted("fr", webhookName);
    return `Le webhook ${quoted} a échoué ${String(limit)} fois de suite et a été désactivé. Réactivez-le depuis les réglages de la base.`;
  }
  const quoted = tableQuoted("en", webhookName);
  return `The webhook ${quoted} failed ${String(limit)} times in a row and was disabled. Re-enable it from the base settings.`;
}

/** What the security mails tell the person (ADR 0043). */
export type SecurityNotice =
  | { kind: "locked"; failures: number; until: Date | null }
  | { kind: "password_changed" }
  | { kind: "factors_removed" }
  | { kind: "inactive_soon"; days: number; disableAt: Date }
  | { kind: "inactive_disabled"; days: number };

/** A date and time in UTC, as the person reads it. */
function moment(locale: MailLocale, date: Date): string {
  const text = new Intl.DateTimeFormat(locale === "fr" ? "fr-FR" : "en-GB", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
  return `${text} UTC`;
}

export function securityMailSubject(
  locale: MailLocale,
  notice: SecurityNotice,
): string {
  const fr = {
    locked: "votre compte est verrouillé",
    password_changed: "votre mot de passe a changé",
    factors_removed: "vos seconds facteurs ont été retirés",
    inactive_soon: "votre compte sera bientôt désactivé",
    inactive_disabled: "votre compte est désactivé",
  };
  const en = {
    locked: "your account is locked",
    password_changed: "your password was changed",
    factors_removed: "your second factors were removed",
    inactive_soon: "your account will soon be disabled",
    inactive_disabled: "your account is disabled",
  };
  return locale === "fr"
    ? `${MAIL_PREFIX}\u00a0: ${fr[notice.kind]}`
    : `${MAIL_PREFIX}: ${en[notice.kind]}`;
}

export function securityMailBody(
  locale: MailLocale,
  notice: SecurityNotice,
): string {
  if (locale === "fr") {
    const warn =
      "Si ce n’était pas vous, prévenez votre administrateur sans attendre.";
    switch (notice.kind) {
      case "locked":
        return `Après ${String(notice.failures)} essais de connexion manqués, votre compte AnyGridDB est verrouillé ${notice.until ? `jusqu’au ${moment(locale, notice.until)}` : "jusqu’à ce qu’un administrateur le déverrouille"}.\n\nSi ce n’était pas vous, quelqu’un essaie peut-être votre mot de passe : prévenez votre administrateur.`;
      case "password_changed":
        return `Le mot de passe de votre compte AnyGridDB vient de changer, et vos autres sessions ont pris fin.\n\n${warn}`;
      case "factors_removed":
        return `Un administrateur a retiré les seconds facteurs de votre compte AnyGridDB (application d’authentification, clés d’accès, codes de secours). Configurez-en un à votre prochaine connexion.\n\n${warn}`;
      case "inactive_soon":
        return `Votre compte AnyGridDB n’a pas servi depuis longtemps. Sans connexion d’ici le ${moment(locale, notice.disableAt)}, il sera désactivé, comme tout compte inutilisé pendant ${String(notice.days)} jours sur cette instance.\n\nPour le garder, connectez-vous simplement.`;
      case "inactive_disabled":
        return `Votre compte AnyGridDB n’a pas servi depuis ${String(notice.days)} jours\u00a0: il est désactivé, et ses jetons d’API ne fonctionnent plus. Ses données restent en place.\n\nPour le retrouver, demandez à un administrateur de le réactiver.`;
    }
  }
  const warn = "If it was not you, tell your administrator at once.";
  switch (notice.kind) {
    case "locked":
      return `After ${String(notice.failures)} failed sign-in attempts, your AnyGridDB account is locked ${notice.until ? `until ${moment(locale, notice.until)}` : "until an administrator unlocks it"}.\n\nIf it was not you, someone may be trying your password: tell your administrator.`;
    case "password_changed":
      return `The password of your AnyGridDB account was just changed, and your other sessions ended.\n\n${warn}`;
    case "factors_removed":
      return `An administrator removed the second factors of your AnyGridDB account (authenticator app, passkeys, backup codes). Set one up again at your next sign-in.\n\n${warn}`;
    case "inactive_soon":
      return `Your AnyGridDB account has not been used for a long time. Unless you sign in by ${moment(locale, notice.disableAt)}, it will be disabled, as any account unused for ${String(notice.days)} days is on this instance.\n\nTo keep it, just sign in.`;
    case "inactive_disabled":
      return `Your AnyGridDB account was not used for ${String(notice.days)} days: it is disabled, and its API tokens stop working. Its data stays.\n\nTo get it back, ask an administrator to enable it again.`;
  }
}

/** What administrators are told when an account locks (ADR 0044). */
export type LockAlert =
  | {
      many: false;
      name: string;
      email: string;
      failures: number;
      until: Date | null;
    }
  | { many: true };

export function lockAlertSubject(locale: MailLocale, alert: LockAlert): string {
  if (alert.many) {
    return locale === "fr"
      ? `${MAIL_PREFIX}\u00a0: de nombreux comptes se verrouillent`
      : `${MAIL_PREFIX}: many accounts are locking`;
  }
  return locale === "fr"
    ? `${MAIL_PREFIX}\u00a0: le compte de ${alert.name} est verrouillé`
    : `${MAIL_PREFIX}: ${alert.name}'s account is locked`;
}

export function lockAlertBody(
  locale: MailLocale,
  alert: LockAlert,
  adminUrl: string,
): string {
  if (alert.many) {
    return locale === "fr"
      ? `Plus de 10 comptes se sont verrouillés en une heure\u00a0: quelqu’un essaie peut-être des mots de passe en masse. Vous ne recevrez plus d’alerte par compte pendant cette heure ; le journal des connexions les garde toutes.\n\n${adminUrl}`
      : `More than 10 accounts locked within an hour: someone may be trying passwords at scale. You will get no more alerts per account for this hour; the sign-in trail keeps them all.\n\n${adminUrl}`;
  }
  const until = alert.until ? moment(locale, alert.until) : null;
  if (locale === "fr") {
    return `Le compte de ${alert.name} (${alert.email}) est verrouillé après ${String(alert.failures)} essais manqués, ${until ? `jusqu’au ${until}` : "jusqu’à ce qu’un administrateur le déverrouille"}.\n\nSi la personne vous le demande, déverrouillez-le depuis Administration > Comptes. Sinon, quelqu’un essaie peut-être son mot de passe.\n\n${adminUrl}`;
  }
  return `${alert.name}'s account (${alert.email}) is locked after ${String(alert.failures)} failed attempts, ${until ? `until ${until}` : "until an administrator unlocks it"}.\n\nIf the person asks, unlock it from Administration > Accounts. Otherwise, someone may be trying their password.\n\n${adminUrl}`;
}

export function resetMailSubject(locale: MailLocale): string {
  return locale === "fr"
    ? `${MAIL_PREFIX}\u00a0: choisir un nouveau mot de passe`
    : `${MAIL_PREFIX}: set a new password`;
}

export function resetMailBody(
  locale: MailLocale,
  input: { link: string; expiresAt: Date; byAdmin: boolean },
): string {
  const until = moment(locale, input.expiresAt);
  if (locale === "fr") {
    const who = input.byAdmin
      ? "Un administrateur vous envoie un lien pour choisir un nouveau mot de passe AnyGridDB."
      : "Vous avez demandé à choisir un nouveau mot de passe AnyGridDB.";
    return `${who}\n\n${input.link}\n\nLe lien sert une fois, jusqu’au ${until}. Vos seconds facteurs restent en place.\n\nSi vous n’avez rien demandé, ignorez ce message\u00a0: votre mot de passe ne change pas.`;
  }
  const who = input.byAdmin
    ? "An administrator sent you a link to set a new AnyGridDB password."
    : "You asked to set a new AnyGridDB password.";
  return `${who}\n\n${input.link}\n\nThe link works once, until ${until}. Your second factors stay as they are.\n\nIf you did not ask for it, ignore this email: your password does not change.`;
}

/** The link that proves the address of a sign-up (ADR 0058). */
export function signupMailSubject(locale: MailLocale): string {
  return locale === "fr"
    ? `${MAIL_PREFIX}\u00a0: confirmer votre adresse`
    : `${MAIL_PREFIX}: confirm your address`;
}

export function signupMailBody(
  locale: MailLocale,
  input: { link: string; expiresAt: Date },
): string {
  const until = moment(locale, input.expiresAt);
  if (locale === "fr") {
    return `Pour créer votre compte AnyGridDB, ouvrez ce lien et saisissez le mot de passe choisi à l’inscription\u00a0:\n\n${input.link}\n\nLe lien sert jusqu’au ${until}.\n\nSi vous n’avez rien demandé, ignorez ce message\u00a0: aucun compte n’est créé.`;
  }
  return `To create your AnyGridDB account, open this link and enter the password you chose when signing up:\n\n${input.link}\n\nThe link works until ${until}.\n\nIf you did not ask for it, ignore this email: no account is created.`;
}

/**
 * A sign-up for an address that has an account already: the person learns
 * it here, never on the page, which answers the same for every address.
 */
export function accountExistsMailSubject(locale: MailLocale): string {
  return locale === "fr"
    ? `${MAIL_PREFIX}\u00a0: vous avez déjà un compte`
    : `${MAIL_PREFIX}: you already have an account`;
}

export function accountExistsMailBody(
  locale: MailLocale,
  input: { loginUrl: string },
): string {
  if (locale === "fr") {
    return `Quelqu’un a voulu créer un compte AnyGridDB avec cette adresse, qui en a déjà un. Rien n’a changé.\n\nPour vous connecter, ou choisir un nouveau mot de passe si vous l’avez oublié :\n\n${input.loginUrl}\n\nSi vous n’avez rien demandé, ignorez ce message.`;
  }
  return `Someone tried to create an AnyGridDB account with this address, which already has one. Nothing changed.\n\nTo sign in, or to set a new password if you forgot it:\n\n${input.loginUrl}\n\nIf you did not ask for it, ignore this email.`;
}

/** An account an administrator created (ROADMAP #67): the first password. */
export function welcomeMailSubject(locale: MailLocale): string {
  return locale === "fr"
    ? `${MAIL_PREFIX}\u00a0: votre compte vous attend`
    : `${MAIL_PREFIX}: your account is ready`;
}

export function welcomeMailBody(
  locale: MailLocale,
  input: { creatorName: string; link: string; expiresAt: Date },
): string {
  const until = moment(locale, input.expiresAt);
  if (locale === "fr") {
    return `${input.creatorName} vous a créé un compte AnyGridDB. Choisissez votre mot de passe avec ce lien\u00a0:\n\n${input.link}\n\nLe lien sert une fois, jusqu’au ${until}. Passé ce délai, demandez-en un nouveau à un administrateur, ou depuis la page de connexion.`;
  }
  return `${input.creatorName} created an AnyGridDB account for you. Choose your password with this link:\n\n${input.link}\n\nThe link works once, until ${until}. After that, ask an administrator for a new one, or ask for one from the sign-in page.`;
}
