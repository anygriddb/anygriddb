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

export async function sendMail(
  config: SmtpConfig,
  message: { to: string; subject: string; text: string },
): Promise<void> {
  if (!smtpReady(config) || !config.SMTP_HOST || !config.SMTP_FROM) {
    throw new AppError("invalid_webhook");
  }
  // Encrypted and verified (ADR 0030): TLS from the start on 465,
  // STARTTLS required elsewhere; a relay on this machine may skip it.
  const implicit = config.SMTP_PORT === 465;
  const transport = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT ?? 587,
    secure: implicit,
    requireTLS: !implicit && !isLoopback(config.SMTP_HOST),
    tls: { minVersion: "TLSv1.2", rejectUnauthorized: true },
    auth:
      config.SMTP_USER && config.SMTP_PASSWORD
        ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD }
        : undefined,
  });
  await transport.sendMail({
    from: config.SMTP_FROM,
    to: message.to,
    subject: message.subject,
    text: message.text,
  });
}
