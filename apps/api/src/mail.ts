import { isLoopback } from "./env.js";
import nodemailer from "nodemailer";
import { AppError } from "@anygriddb/core";

export type SmtpConfig = {
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
};

export function smtpReady(config: SmtpConfig): boolean {
  return Boolean(config.SMTP_HOST && config.SMTP_FROM);
}

/**
 * Encrypted and verified (ADR 0030): TLS from the start on 465, STARTTLS
 * required elsewhere; a relay on this machine may skip it. Waits are
 * bounded, so a relay that stops answering does not hold a worker or the
 * settings page.
 */
function transportFor(config: SmtpConfig & { SMTP_HOST: string }) {
  const implicit = config.SMTP_PORT === 465;
  return nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? 587,
    secure: implicit,
    requireTLS: !implicit && !isLoopback(config.SMTP_HOST),
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    auth:
      config.SMTP_USER && config.SMTP_PASSWORD
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
  });
}

/** Who a mail is from and how it closes: the instance's voice (ADR 0072). */
type MailIdentity = {
  /** Before the sender's address; null leaves the address alone. */
  sender: string | null;
  signature: string | null;
};

/** The address of a sender that may already carry a name: "Name <a@b>". */
function addressOf(from: string): string {
  return /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from.trim();
}

/** The sender as the mailer takes it: it encodes the name for the header. */
export function mailFrom(
  from: string,
  identity: MailIdentity,
): string | { name: string; address: string } {
  return identity.sender
    ? { name: identity.sender, address: addressOf(from) }
    : from;
}

/** The text with the instance's signature under it, after "-- " alone. */
export function signedText(text: string, identity: MailIdentity): string {
  return identity.signature
    ? `${text.trimEnd()}\n\n-- \n${identity.signature}`
    : text;
}

/**
 * Every mail leaves here, under the instance's voice: its sender name and
 * its signature are added once, for all of them.
 */
export async function sendMail(
  config: SmtpConfig,
  identity: MailIdentity,
  message: { to: string; subject: string; text: string },
): Promise<void> {
  const { SMTP_HOST, SMTP_FROM } = config;
  if (!SMTP_HOST || !SMTP_FROM) {
    throw new AppError("invalid_webhook");
  }
  const transport = transportFor({ ...config, SMTP_HOST });
  try {
    await transport.sendMail({
      from: mailFrom(SMTP_FROM, identity),
      to: message.to,
      subject: message.subject,
      text: signedText(message.text, identity),
    });
  } finally {
    transport.close();
  }
}

/**
 * Asks the relay to prove it takes mail with these settings: it answers,
 * speaks TLS, and accepts the account. Nothing is sent.
 */
export async function verifySmtp(config: SmtpConfig): Promise<void> {
  const { SMTP_HOST } = config;
  if (!SMTP_HOST || !config.SMTP_FROM) {
    throw new AppError("smtp_not_configured");
  }
  const transport = transportFor({ ...config, SMTP_HOST });
  try {
    await transport.verify();
  } catch (error) {
    throw new AppError("invalid_smtp", {
      cause: error instanceof Error ? error : undefined,
    });
  } finally {
    transport.close();
  }
}
