/**
 * Email + free carrier-gateway SMS notifications.
 *
 * Email goes out through the owner's Gmail (free, ~500/day) via
 * GMAIL_USER / GMAIL_APP_PASSWORD. Everything is a silent no-op until
 * those are set — same pattern as sms.ts / push.ts.
 *
 * "Free SMS" rides on US carriers' email-to-SMS gateways: we send an email
 * to 2125551234@vtext.com and the carrier delivers it as a text. It costs
 * nothing but is best-effort — the customer must pick their carrier, and
 * delivery can be slow or lossy. Keep gateway texts short.
 */
import nodemailer from 'nodemailer';
import { EMAIL_RE } from './emailValidation.js';

const GMAIL_USER = process.env.GMAIL_USER || '';
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || '';

export const emailEnabled = Boolean(GMAIL_USER && GMAIL_APP_PASSWORD);

if (emailEnabled) {
  console.log('[email] Email notifications enabled (Gmail SMTP)');
} else {
  console.log('[email] GMAIL_USER / GMAIL_APP_PASSWORD not set — email notifications disabled.');
}

let transporter: nodemailer.Transporter | null = null;
function getTransporter(): nodemailer.Transporter | null {
  if (!emailEnabled) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false, // STARTTLS
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

/** Quick format check for optional notification addresses (no DNS lookup). */
export function validNotifyEmail(raw: unknown): string | null {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return null;
  return EMAIL_RE.test(v) ? v : null;
}

// ---------- Free SMS via carrier email-to-SMS gateways ----------

export interface SmsCarrier {
  id: string;
  label: string;
  domain: string;
}

export const SMS_CARRIERS: SmsCarrier[] = [
  { id: 'verizon', label: 'Verizon', domain: 'vtext.com' },
  { id: 'tmobile', label: 'T-Mobile', domain: 'tmomail.net' },
  { id: 'att', label: 'AT&T', domain: 'txt.att.net' },
  { id: 'googlefi', label: 'Google Fi', domain: 'msg.fi.google.com' },
  { id: 'uscellular', label: 'US Cellular', domain: 'email.uscc.net' },
  { id: 'cricket', label: 'Cricket', domain: 'sms.cricketwireless.net' },
  { id: 'boost', label: 'Boost Mobile', domain: 'sms.myboostmobile.com' },
  { id: 'mint', label: 'Mint Mobile', domain: 'mailmymobile.net' },
  { id: 'metro', label: 'Metro by T-Mobile', domain: 'mymetropcs.com' },
];

export function carrierById(id: unknown): SmsCarrier | null {
  if (!id) return null;
  return SMS_CARRIERS.find((c) => c.id === String(id).toLowerCase()) || null;
}

/** 10-digit national number for gateway addressing, or null. */
export function smsDigits(phone: unknown): string | null {
  if (!phone) return null;
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return d.slice(1);
  if (d.length === 10) return d;
  return null;
}

/** e.g. 2125551234@vtext.com — null when carrier/phone can't map. */
export function gatewayAddress(phone: unknown, carrierId: unknown): string | null {
  const c = carrierById(carrierId);
  const d = smsDigits(phone);
  if (!c || !d) return null;
  return `${d}@${c.domain}`;
}

// ---------- Sending ----------

export async function sendEmail(to: string, subject: string, text: string): Promise<boolean> {
  const t = getTransporter();
  if (!t || !to) return false;
  try {
    await t.sendMail({ from: GMAIL_USER, to, subject, text });
    return true;
  } catch (e: any) {
    console.error('[email] send failed', e?.message);
    return false;
  }
}

/** Free, best-effort SMS through the carrier gateway. False when unusable. */
export async function sendGatewaySms(
  phone: unknown,
  carrierId: unknown,
  text: string
): Promise<boolean> {
  const addr = gatewayAddress(phone, carrierId);
  if (!addr) return false;
  // Gateway texts work best short — carriers may split or drop long ones.
  return sendEmail(addr, '', text.slice(0, 300));
}

export interface NotifyContact {
  email?: string | null;
  phone?: string | null;
  carrier?: string | null;
}

/**
 * Notify one contact by every free channel available: email if we have an
 * address, gateway SMS if we have a phone + carrier. Never throws.
 */
export async function notifyContact(
  contact: NotifyContact,
  subject: string,
  emailBody: string,
  smsBody: string
): Promise<void> {
  const jobs: Promise<boolean>[] = [];
  if (contact.email) jobs.push(sendEmail(contact.email, subject, emailBody));
  if (contact.phone && contact.carrier)
    jobs.push(sendGatewaySms(contact.phone, contact.carrier, smsBody));
  if (jobs.length === 0) return;
  await Promise.all(jobs.map((j) => j.catch(() => false)));
}
