// SMS notifications via Twilio (optional).
// Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER to enable.
// When unset, everything below is a silent no-op — the app works exactly as before.

const SID = process.env.TWILIO_ACCOUNT_SID || '';
const TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const FROM = process.env.TWILIO_FROM_NUMBER || '';

export const smsConfigured = Boolean(SID && TOKEN && FROM);

// Normalize a freeform phone number to E.164. Assumes a US number when the
// customer typed 10 digits without a country code.
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) return '+' + digits;
  if (digits.length === 10) return '+1' + digits;
  if (raw.trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) return '+' + digits;
  return null;
}

export async function sendSms(to: string, body: string): Promise<void> {
  if (!smsConfigured) return;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`;
  const params = new URLSearchParams({ To: to, From: FROM, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Twilio SMS failed (${res.status}): ${text.slice(0, 200)}`);
  }
}

// Fire-and-forget: text the customer when their order (or part of it) is ready.
export function maybeSendReadySms(
  orderNumber: number,
  customerPhone: string | null,
  partial = false
): void {
  if (!smsConfigured) return;
  const to = normalizePhone(customerPhone);
  if (!to) return;
  const body = partial
    ? `Part of your order #${orderNumber} is ready for pickup!`
    : `Your order #${orderNumber} is ready for pickup!`;
  sendSms(to, body).catch((e) => console.error('[sms] send failed', e.message));
}
