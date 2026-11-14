import {
  PRODUCT_NAME,
  WEBHOOK_FAILURE_LIMIT,
  type AlertKind,
  type InstanceSettings,
} from "@anygriddb/core";
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

/**
 * How the instance speaks in a mail (ADR 0072): the reader's language,
 * the name it goes by, the name its mail is sent under, what closes each
 * mail, and its own note in an invitation. Every mail is written and sent
 * with one, so that none leaves under another name than the others.
 */
export type MailVoice = {
  locale: MailLocale;
  /** The instance's name, or the product's until it has one. */
  name: string;
  /** Before the sender's address; null leaves the address alone. */
  sender: string | null;
  signature: string | null;
  invitationNote: string | null;
};

/** The voice for a reader: their language when known, else the instance's. */
export function mailVoice(
  settings: Pick<
    InstanceSettings,
    | "defaultLocale"
    | "instanceName"
    | "mailSenderName"
    | "mailSignatureEn"
    | "mailSignatureFr"
    | "mailInvitationEn"
    | "mailInvitationFr"
  >,
  preference?: MailLocale | null,
): MailVoice {
  const locale = resolveLocale(preference, settings.defaultLocale);
  const french = locale === "fr";
  return {
    locale,
    name: settings.instanceName ?? PRODUCT_NAME,
    sender: settings.mailSenderName ?? settings.instanceName,
    signature: french ? settings.mailSignatureFr : settings.mailSignatureEn,
    invitationNote: french
      ? settings.mailInvitationFr
      : settings.mailInvitationEn,
  };
}

function tableQuoted(locale: MailLocale, tableName: string): string {
  if (locale === "fr") {
    return `«\u00a0${tableName}\u00a0»`;
  }
  return `"${tableName}"`;
}

const NOTIFICATION_SUBJECTS: Record<
  MailLocale,
  Record<NotificationKind, (tableName: string, name: string) => string>
> = {
  en: {
    mention: (table) => `You were mentioned in ${tableQuoted("en", table)}`,
    reply: (table) => `New reply in ${tableQuoted("en", table)}`,
    assigned: (table) =>
      `A row was assigned to you in ${tableQuoted("en", table)}`,
    automation: (table) => `Automation in ${tableQuoted("en", table)}`,
    webhook_disabled: (table) =>
      `Webhook disabled on ${tableQuoted("en", table)}`,
    row_changed: (table, name) =>
      `A locked row in ${tableQuoted("en", table)} changed outside ${name}`,
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
    row_changed: (table, name) =>
      `Une ligne verrouillée de ${tableQuoted("fr", table)} a changé sans passer par ${name}`,
  },
};

const NOTIFICATION_FOOTER: Record<MailLocale, string> = {
  en: "You receive this email because email notifications are enabled in your settings.",
  fr: "Vous recevez cet email car les notifications par email sont activées dans vos réglages.",
};

export function notificationSubject(
  voice: MailVoice,
  kind: NotificationKind,
  tableName: string,
): string {
  return NOTIFICATION_SUBJECTS[voice.locale][kind](tableName, voice.name);
}

export function notificationMailSubject(
  voice: MailVoice,
  kind: NotificationKind,
  tableName: string,
): string {
  const separator = voice.locale === "fr" ? "\u00a0: " : ": ";
  return `${voice.name}${separator}${notificationSubject(voice, kind, tableName)}`;
}

export function notificationMailBody(
  voice: MailVoice,
  kind: NotificationKind,
  tableName: string,
  link: string,
): string {
  const subject = notificationSubject(voice, kind, tableName);
  return `${subject}.\n\n${link}\n\n${NOTIFICATION_FOOTER[voice.locale]}`;
}

export function invitationMailSubject(
  voice: MailVoice,
  baseName: string,
): string {
  const quoted = tableQuoted(voice.locale, baseName);
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: invitation à ${quoted}`
    : `${voice.name}: invitation to ${quoted}`;
}

export function invitationMailBody(
  voice: MailVoice,
  input: {
    inviterName: string;
    link: string;
    expiresDate: string;
  },
): string {
  // The instance's own note sits between who invites and the link: the
  // link and its expiry are there whatever the note says.
  const note = voice.invitationNote ? `${voice.invitationNote}\n\n` : "";
  if (voice.locale === "fr") {
    return `${input.inviterName} vous invite sur ${voice.name}.\n\n${note}${input.link}\n\nLe lien expire le ${input.expiresDate}.`;
  }
  return `${input.inviterName} invited you to ${voice.name}.\n\n${note}${input.link}\n\nThe link expires on ${input.expiresDate}.`;
}

export function testMailSubject(voice: MailVoice): string {
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: message de test`
    : `${voice.name}: test message`;
}

export function testMailBody(voice: MailVoice): string {
  return voice.locale === "fr"
    ? "Ce message confirme que cette instance envoie bien ses emails."
    : "This message confirms that this instance can send email.";
}

/** Fixed footer on an administrator's notice to accounts (ADR 0052). */
export function operatorMailFooter(voice: MailVoice): string {
  return voice.locale === "fr"
    ? `Ce message a été envoyé par un administrateur de votre instance ${voice.name}.`
    : `This message was sent by an administrator of your ${voice.name} instance.`;
}

export function operatorMailText(voice: MailVoice, body: string): string {
  return `${body.trimEnd()}\n\n—\n${operatorMailFooter(voice)}`;
}

export function webhookDisabledMailSubject(voice: MailVoice): string {
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: webhook désactivé`
    : `${voice.name}: webhook disabled`;
}

export function webhookDisabledMailBody(
  voice: MailVoice,
  webhookName: string,
): string {
  const limit = WEBHOOK_FAILURE_LIMIT;
  if (voice.locale === "fr") {
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
  voice: MailVoice,
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
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: ${fr[notice.kind]}`
    : `${voice.name}: ${en[notice.kind]}`;
}

export function securityMailBody(
  voice: MailVoice,
  notice: SecurityNotice,
): string {
  if (voice.locale === "fr") {
    const warn =
      "Si ce n’était pas vous, prévenez votre administrateur sans attendre.";
    switch (notice.kind) {
      case "locked":
        return `Après ${String(notice.failures)} essais de connexion manqués, votre compte ${voice.name} est verrouillé ${notice.until ? `jusqu’au ${moment(voice.locale, notice.until)}` : "jusqu’à ce qu’un administrateur le déverrouille"}.\n\nSi ce n’était pas vous, quelqu’un essaie peut-être votre mot de passe : prévenez votre administrateur.`;
      case "password_changed":
        return `Le mot de passe de votre compte ${voice.name} vient de changer, et vos autres sessions ont pris fin.\n\n${warn}`;
      case "factors_removed":
        return `Un administrateur a retiré les seconds facteurs de votre compte ${voice.name} (application d’authentification, clés d’accès, codes de secours). Configurez-en un à votre prochaine connexion.\n\n${warn}`;
      case "inactive_soon":
        return `Votre compte ${voice.name} n’a pas servi depuis longtemps. Sans connexion d’ici le ${moment(voice.locale, notice.disableAt)}, il sera désactivé, comme tout compte inutilisé pendant ${String(notice.days)} jours sur cette instance.\n\nPour le garder, connectez-vous simplement.`;
      case "inactive_disabled":
        return `Votre compte ${voice.name} n’a pas servi depuis ${String(notice.days)} jours\u00a0: il est désactivé, et ses jetons d’API ne fonctionnent plus. Ses données restent en place.\n\nPour le retrouver, demandez à un administrateur de le réactiver.`;
    }
  }
  const warn = "If it was not you, tell your administrator at once.";
  switch (notice.kind) {
    case "locked":
      return `After ${String(notice.failures)} failed sign-in attempts, your ${voice.name} account is locked ${notice.until ? `until ${moment(voice.locale, notice.until)}` : "until an administrator unlocks it"}.\n\nIf it was not you, someone may be trying your password: tell your administrator.`;
    case "password_changed":
      return `The password of your ${voice.name} account was just changed, and your other sessions ended.\n\n${warn}`;
    case "factors_removed":
      return `An administrator removed the second factors of your ${voice.name} account (authenticator app, passkeys, backup codes). Set one up again at your next sign-in.\n\n${warn}`;
    case "inactive_soon":
      return `Your ${voice.name} account has not been used for a long time. Unless you sign in by ${moment(voice.locale, notice.disableAt)}, it will be disabled, as any account unused for ${String(notice.days)} days is on this instance.\n\nTo keep it, just sign in.`;
    case "inactive_disabled":
      return `Your ${voice.name} account was not used for ${String(notice.days)} days: it is disabled, and its API tokens stop working. Its data stays.\n\nTo get it back, ask an administrator to enable it again.`;
  }
}

/** An open alert as a mail names it (ROADMAP #25). */
export type MailedAlert = {
  kind: AlertKind;
  detail: Record<string, string | number | null>;
};

function alertLine(locale: MailLocale, alert: MailedAlert): string {
  const { detail } = alert;
  const when = (value: unknown) =>
    typeof value === "string" ? moment(locale, new Date(value)) : null;
  const fr = locale === "fr";
  switch (alert.kind) {
    case "backup_late": {
      const last = when(detail.lastGoodAt);
      return fr
        ? `Aucune sauvegarde n’a réussi depuis plus de ${String(detail.hours)} heures. La dernière réussie\u00a0: ${last ?? "aucune"}.`
        : `No backup has succeeded for more than ${String(detail.hours)} hours. The last that did: ${last ?? "none"}.`;
    }
    case "backup_failed":
      return fr
        ? `La dernière sauvegarde a échoué, le ${when(detail.failedAt) ?? ""}.`
        : `The last backup failed, on ${when(detail.failedAt) ?? ""}.`;
    case "storage_full":
      return fr
        ? `Le volume où sont les fichiers est plein à ${String(detail.percent)}\u00a0% (alerte à ${String(detail.threshold)}\u00a0%).`
        : `The volume the files are on is ${String(detail.percent)}% full (alert at ${String(detail.threshold)}%).`;
    case "certificate_expiring":
      return fr
        ? `Le certificat de l’instance expire dans ${String(detail.days)} jours, le ${when(detail.expiresAt) ?? ""}.`
        : `The instance's certificate expires in ${String(detail.days)} days, on ${when(detail.expiresAt) ?? ""}.`;
    case "source_unreachable":
      return fr
        ? `La source ${String(detail.name)} ne répond pas\u00a0: ses tables surveillées n’ont pas pu être lues.`
        : `The source ${String(detail.name)} does not answer: its watched tables could not be read.`;
    case "failures":
      return fr
        ? `${String(detail.count)} tâches, envois de webhooks et exécutions d’automatisations ont échoué en 24 heures (alerte à ${String(detail.threshold)}).`
        : `${String(detail.count)} jobs, webhook deliveries, and automation runs failed in 24 hours (alert at ${String(detail.threshold)}).`;
  }
}

const ALERT_TITLES: Record<AlertKind, [en: string, fr: string]> = {
  backup_late: ["the backup is late", "la sauvegarde est en retard"],
  backup_failed: ["the last backup failed", "la dernière sauvegarde a échoué"],
  storage_full: [
    "file storage is nearly full",
    "le stockage des fichiers est presque plein",
  ],
  certificate_expiring: [
    "the certificate is close to expiry",
    "le certificat expire bientôt",
  ],
  source_unreachable: ["a source does not answer", "une source ne répond pas"],
  failures: ["failures are piling up", "les échecs s’accumulent"],
};

export function alertMailSubject(
  voice: MailVoice,
  alerts: readonly MailedAlert[],
): string {
  const first = alerts[0];
  if (alerts.length === 1 && first) {
    const [en, fr] = ALERT_TITLES[first.kind];
    return voice.locale === "fr"
      ? `${voice.name}\u00a0: ${fr}`
      : `${voice.name}: ${en}`;
  }
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: ${String(alerts.length)} alertes sont ouvertes`
    : `${voice.name}: ${String(alerts.length)} alerts are open`;
}

export function alertMailBody(
  voice: MailVoice,
  alerts: readonly MailedAlert[],
  healthUrl: string,
): string {
  const lines = alerts.map((alert) => `- ${alertLine(voice.locale, alert)}`);
  const close =
    voice.locale === "fr"
      ? "Une alerte se ferme d’elle-même quand sa cause a disparu. Tant qu’elle reste ouverte, vous êtes prévenu une fois par jour au plus. Les seuils se règlent dans Administration > Santé."
      : "An alert closes by itself once its cause is gone. While it stays open, you are told once a day at most. Thresholds are set in Administration > Health.";
  return `${lines.join("\n")}\n\n${close}\n\n${healthUrl}`;
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

export function lockAlertSubject(voice: MailVoice, alert: LockAlert): string {
  if (alert.many) {
    return voice.locale === "fr"
      ? `${voice.name}\u00a0: de nombreux comptes se verrouillent`
      : `${voice.name}: many accounts are locking`;
  }
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: le compte de ${alert.name} est verrouillé`
    : `${voice.name}: ${alert.name}'s account is locked`;
}

export function lockAlertBody(
  voice: MailVoice,
  alert: LockAlert,
  adminUrl: string,
): string {
  if (alert.many) {
    return voice.locale === "fr"
      ? `Plus de 10 comptes se sont verrouillés en une heure\u00a0: quelqu’un essaie peut-être des mots de passe en masse. Vous ne recevrez plus d’alerte par compte pendant cette heure ; le journal des connexions les garde toutes.\n\n${adminUrl}`
      : `More than 10 accounts locked within an hour: someone may be trying passwords at scale. You will get no more alerts per account for this hour; the sign-in trail keeps them all.\n\n${adminUrl}`;
  }
  const until = alert.until ? moment(voice.locale, alert.until) : null;
  if (voice.locale === "fr") {
    return `Le compte de ${alert.name} (${alert.email}) est verrouillé après ${String(alert.failures)} essais manqués, ${until ? `jusqu’au ${until}` : "jusqu’à ce qu’un administrateur le déverrouille"}.\n\nSi la personne vous le demande, déverrouillez-le depuis Administration > Comptes. Sinon, quelqu’un essaie peut-être son mot de passe.\n\n${adminUrl}`;
  }
  return `${alert.name}'s account (${alert.email}) is locked after ${String(alert.failures)} failed attempts, ${until ? `until ${until}` : "until an administrator unlocks it"}.\n\nIf the person asks, unlock it from Administration > Accounts. Otherwise, someone may be trying their password.\n\n${adminUrl}`;
}

export function resetMailSubject(voice: MailVoice): string {
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: choisir un nouveau mot de passe`
    : `${voice.name}: set a new password`;
}

export function resetMailBody(
  voice: MailVoice,
  input: { link: string; expiresAt: Date; byAdmin: boolean },
): string {
  const until = moment(voice.locale, input.expiresAt);
  if (voice.locale === "fr") {
    const who = input.byAdmin
      ? `Un administrateur vous envoie un lien pour choisir un nouveau mot de passe ${voice.name}.`
      : `Vous avez demandé à choisir un nouveau mot de passe ${voice.name}.`;
    return `${who}\n\n${input.link}\n\nLe lien sert une fois, jusqu’au ${until}. Vos seconds facteurs restent en place.\n\nSi vous n’avez rien demandé, ignorez ce message\u00a0: votre mot de passe ne change pas.`;
  }
  const who = input.byAdmin
    ? `An administrator sent you a link to set a new ${voice.name} password.`
    : `You asked to set a new ${voice.name} password.`;
  return `${who}\n\n${input.link}\n\nThe link works once, until ${until}. Your second factors stay as they are.\n\nIf you did not ask for it, ignore this email: your password does not change.`;
}

/** The link that proves the address of a sign-up (ADR 0058). */
export function signupMailSubject(voice: MailVoice): string {
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: confirmer votre adresse`
    : `${voice.name}: confirm your address`;
}

export function signupMailBody(
  voice: MailVoice,
  input: { link: string; expiresAt: Date },
): string {
  const until = moment(voice.locale, input.expiresAt);
  if (voice.locale === "fr") {
    return `Pour créer votre compte ${voice.name}, ouvrez ce lien et saisissez le mot de passe choisi à l’inscription\u00a0:\n\n${input.link}\n\nLe lien sert jusqu’au ${until}.\n\nSi vous n’avez rien demandé, ignorez ce message\u00a0: aucun compte n’est créé.`;
  }
  return `To create your ${voice.name} account, open this link and enter the password you chose when signing up:\n\n${input.link}\n\nThe link works until ${until}.\n\nIf you did not ask for it, ignore this email: no account is created.`;
}

/**
 * A sign-up for an address that has an account already: the person learns
 * it here, never on the page, which answers the same for every address.
 */
export function accountExistsMailSubject(voice: MailVoice): string {
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: vous avez déjà un compte`
    : `${voice.name}: you already have an account`;
}

export function accountExistsMailBody(
  voice: MailVoice,
  input: { loginUrl: string },
): string {
  if (voice.locale === "fr") {
    return `Quelqu’un a voulu créer un compte ${voice.name} avec cette adresse, qui en a déjà un. Rien n’a changé.\n\nPour vous connecter, ou choisir un nouveau mot de passe si vous l’avez oublié :\n\n${input.loginUrl}\n\nSi vous n’avez rien demandé, ignorez ce message.`;
  }
  return `Someone tried to create an ${voice.name} account with this address, which already has one. Nothing changed.\n\nTo sign in, or to set a new password if you forgot it:\n\n${input.loginUrl}\n\nIf you did not ask for it, ignore this email.`;
}

/** An account an administrator created (ROADMAP #67): the first password. */
export function welcomeMailSubject(voice: MailVoice): string {
  return voice.locale === "fr"
    ? `${voice.name}\u00a0: votre compte vous attend`
    : `${voice.name}: your account is ready`;
}

export function welcomeMailBody(
  voice: MailVoice,
  input: { creatorName: string; link: string; expiresAt: Date },
): string {
  const until = moment(voice.locale, input.expiresAt);
  if (voice.locale === "fr") {
    return `${input.creatorName} vous a créé un compte ${voice.name}. Choisissez votre mot de passe avec ce lien\u00a0:\n\n${input.link}\n\nLe lien sert une fois, jusqu’au ${until}. Passé ce délai, demandez-en un nouveau à un administrateur, ou depuis la page de connexion.`;
  }
  return `${input.creatorName} created an ${voice.name} account for you. Choose your password with this link:\n\n${input.link}\n\nThe link works once, until ${until}. After that, ask an administrator for a new one, or ask for one from the sign-in page.`;
}
