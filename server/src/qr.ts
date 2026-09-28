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
