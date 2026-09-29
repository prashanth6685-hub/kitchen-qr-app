import { randomBytes } from 'node:crypto';
import QRCode from 'qrcode';

/** Secure, unguessable public token for the customer tracking URL. */
export function generatePublicToken(): string {
  return randomBytes(16).toString('hex'); // 32 hex chars
}

export function trackingUrl(publicToken: string): string {
  const base = (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
  return `${base}/order/${publicToken}`;
}

/** Render a PNG data-URL / buffer of the QR code containing ONLY the order URL. */
export async function qrPngBuffer(publicToken: string): Promise<Buffer> {
  return QRCode.toBuffer(trackingUrl(publicToken), {
    type: 'png',
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
}

// ---------- Module 2: waiting list ----------

function publicBase(): string {
  return (process.env.PUBLIC_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
}

/** Customer tracking page URL for a waitlist entry (encoded in the customer's QR). */
export function waitlistTrackingUrl(publicToken: string): string {
  return `${publicBase()}/wait/${publicToken}`;
}

/** Permanent restaurant check-in page URL (encoded in the restaurant's QR). */
export function checkinUrl(slug: string): string {
  return `${publicBase()}/checkin/${slug}`;
}

/** Render a PNG buffer of a QR code for any URL (never embeds personal data). */
export async function qrPngBufferForUrl(url: string): Promise<Buffer> {
  return QRCode.toBuffer(url, {
    type: 'png',
    width: 512,
    margin: 2,
    errorCorrectionLevel: 'M',
  });
}
