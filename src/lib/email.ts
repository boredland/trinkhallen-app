/**
 * Outbound email via the Cloudflare `send_email` Worker binding.
 *
 * We compose RFC 2822 messages by hand — the binding takes a raw text blob.
 * Multipart/alternative gives us both HTML and plain-text bodies in one shot
 * so mail clients can pick what they render.
 */

import { EmailMessage } from "cloudflare:email";
import type { Env } from "../env";

export const FROM_ADDRESS = "feedback@trinkhallen.app";
export const FROM_NAME = "trinkhallen.app";

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export async function sendEmail(env: Env, msg: EmailPayload): Promise<void> {
  const raw = compose(msg);
  const message = new EmailMessage(FROM_ADDRESS, msg.to, raw);
  await env.EMAIL.send(message);
}

function compose(msg: EmailPayload): string {
  const boundary = `tk-${crypto.randomUUID()}`;
  const fromHeader = `${encodeDisplayName(FROM_NAME)} <${FROM_ADDRESS}>`;

  const headers = [
    `From: ${fromHeader}`,
    `To: ${msg.to}`,
    `Subject: ${encodeHeader(msg.subject)}`,
    `Message-ID: <${crypto.randomUUID()}@trinkhallen.app>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
  ];

  if (!msg.html) {
    headers.push(`Content-Type: text/plain; charset="utf-8"`, `Content-Transfer-Encoding: 8bit`);
    return `${headers.join("\r\n")}\r\n\r\n${msg.text}`;
  }

  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body = [
    `--${boundary}`,
    `Content-Type: text/plain; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    "",
    msg.text,
    `--${boundary}`,
    `Content-Type: text/html; charset="utf-8"`,
    `Content-Transfer-Encoding: 8bit`,
    "",
    msg.html,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

function encodeHeader(value: string): string {
  // Quoted-printable wrapping for any non-ASCII chars in subject/display name.
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const b64 = btoa(unescape(encodeURIComponent(value)));
  return `=?UTF-8?B?${b64}?=`;
}

function encodeDisplayName(name: string): string {
  return /^[\w .\-()]+$/.test(name) ? name : `"${encodeHeader(name)}"`;
}
