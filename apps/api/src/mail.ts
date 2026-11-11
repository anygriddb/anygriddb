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

export async function sendMail(
  config: SmtpConfig,
  message: { to: string; subject: string; text: string },
): Promise<void> {
  const { SMTP_HOST, SMTP_FROM } = config;
  if (!SMTP_HOST || !SMTP_FROM) {
    throw new AppError("invalid_webhook");
  }
  const transport = transportFor({ ...config, SMTP_HOST });
  try {
    await transport.sendMail({
      from: SMTP_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
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
