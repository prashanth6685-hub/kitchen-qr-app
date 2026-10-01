import { Router } from 'express';
import { all, row, run } from './db.js';
import { AuthRequest, requireAuth, requireRole } from './auth.js';

export const discountsRouter = Router();

export interface DiscountCodeRow {
  id: number;
  code: string;
  label: string | null;
  menu_item_id: number | null;
  menu_item_name: string | null;
  amount_cents: number | null;
  percent_off: number | null;
  active: number;
  created_at: string;
  updated_at: string;
}

function withItemName(r: any): DiscountCodeRow {
  return r;
}

/** Normalize a code for storage/comparison: trimmed + uppercased. */
export function normalizeCode(raw: string): string {
  return String(raw || '').trim().toUpperCase();
}

export async function findCode(code: string): Promise<DiscountCodeRow | undefined> {  return await row<DiscountCodeRow>(
    `SELECT d.*, m.name AS menu_item_name FROM discount_codes d
     LEFT JOIN menu_items m ON m.id = d.menu_item_id
     WHERE d.code = ?`,
    normalizeCode(code)
  );
}

async function validatePayload(body: any): Promise<{ ok: boolean; error?: string; clean?: any }> {
  const code = normalizeCode(body?.code);
  if (!code || code.length > 40) return { ok: false, error: 'Enter a discount code (max 40 characters)' };
  const label = body?.label ? String(body.label).trim().slice(0, 120) : null;
  const menu_item_id =
    body?.menu_item_id === null || body?.menu_item_id === undefined || body?.menu_item_id === ''
      ? null
      : Number(body.menu_item_id);
  if (menu_item_id !== null && (!Number.isInteger(menu_item_id) || menu_item_id < 1)) {
    return { ok: false, error: 'Invalid menu item' };
  }
  if (menu_item_id !== null && !await row('SELECT id FROM menu_items WHERE id = ?', menu_item_id)) {
    return { ok: false, error: 'Menu item not found' };
  }
  const amount_cents =
    body?.amount_cents === null || body?.amount_cents === undefined || body?.amount_cents === ''
      ? null
      : Math.round(Number(body.amount_cents));
  const percent_off =
    body?.percent_off === null || body?.percent_off === undefined || body?.percent_off === ''
      ? null
      : Math.round(Number(body.percent_off));
  const hasAmount = amount_cents !== null && Number.isFinite(amount_cents) && amount_cents > 0;
  const hasPercent = percent_off !== null && Number.isFinite(percent_off) && percent_off > 0 && percent_off <= 100;
  if (hasAmount === hasPercent) {
    return { ok: false, error: 'Set either a fixed amount off or a percent off (not both)' };
  }
  const active = body?.active === false || body?.active === 0 ? 0 : 1;
  return {
    ok: true,
    clean: {
      code,
      label,
      menu_item_id,
      amount_cents: hasAmount ? amount_cents : null,
      percent_off: hasPercent ? percent_off : null,
      active,
    },
  };
}

discountsRouter.use(requireAuth);

discountsRouter.get('/', async (req: AuthRequest, res) => {
  const rows = await all<DiscountCodeRow>(
    `SELECT d.*, m.name AS menu_item_name FROM discount_codes d
     LEFT JOIN menu_items m ON m.id = d.menu_item_id
     ORDER BY d.active DESC, d.code`
  );
  res.json(rows.map(withItemName));
});

// Validate a code against an item name (for the per-item discount UI).
// Returns 200 with the code's value, or 4xx with a reason.
discountsRouter.post('/validate', async (req: AuthRequest, res) => {
  const itemName = String(req.body?.item_name || '').trim();
  const dc = await findCode(String(req.body?.code || ''));
  if (!dc) return res.status(404).json({ error: 'Discount code not found' });
  if (!dc.active) return res.status(400).json({ error: `Code ${dc.code} is inactive` });
  if (dc.menu_item_name && dc.menu_item_name.toLowerCase() !== itemName.toLowerCase()) {
    return res.status(400).json({ error: `Code ${dc.code} only applies to ${dc.menu_item_name}` });
  }
  res.json({
    ok: true,
    code: dc.code,
    label: dc.label,
    amount_cents: dc.amount_cents,
    percent_off: dc.percent_off,
    menu_item_name: dc.menu_item_name,
  });
});

discountsRouter.post('/', requireRole('ADMIN'), async (req: AuthRequest, res) => {
  const v = await validatePayload(req.body);
  if (!v.ok) return res.status(400).json({ error: v.error });
  if (await findCode(v.clean.code)) return res.status(409).json({ error: `Code ${v.clean.code} already exists` });
  const r = await run(
    `INSERT INTO discount_codes (code, label, menu_item_id, amount_cents, percent_off, active)
     VALUES (?, ?, ?, ?, ?, ?)`,
    v.clean.code, v.clean.label, v.clean.menu_item_id,
    v.clean.amount_cents, v.clean.percent_off, v.clean.active
  );
  res.status(201).json(await findCode(v.clean.code) ?? { id: Number(r.lastInsertRowid), ...v.clean });
});

discountsRouter.put('/:id', requireRole('ADMIN'), async (req: AuthRequest, res) => {
  const existing = await row<DiscountCodeRow>(
    `SELECT d.*, m.name AS menu_item_name FROM discount_codes d
     LEFT JOIN menu_items m ON m.id = d.menu_item_id WHERE d.id = ?`,
    req.params.id
  );
  if (!existing) return res.status(404).json({ error: 'Discount code not found' });
  // Partial update: fields not sent keep their current values.
  const body = req.body ?? {};
  const merged = {
    code: body.code !== undefined ? body.code : existing.code,
    label: body.label !== undefined ? body.label : existing.label,
    menu_item_id: body.menu_item_id !== undefined ? body.menu_item_id : existing.menu_item_id,
    amount_cents: body.amount_cents !== undefined ? body.amount_cents : existing.amount_cents,
    percent_off: body.percent_off !== undefined ? body.percent_off : existing.percent_off,
    active: body.active !== undefined ? body.active : existing.active,
  };
  const v = await validatePayload(merged);
  if (!v.ok) return res.status(400).json({ error: v.error });
  const clash = await row('SELECT id FROM discount_codes WHERE code = ? AND id != ?', v.clean.code, req.params.id);
  if (clash) return res.status(409).json({ error: `Code ${v.clean.code} already exists` });
  await run(
    `UPDATE discount_codes SET code = ?, label = ?, menu_item_id = ?, amount_cents = ?,
       percent_off = ?, active = ?, updated_at = datetime('now') WHERE id = ?`,
    v.clean.code, v.clean.label, v.clean.menu_item_id,
    v.clean.amount_cents, v.clean.percent_off, v.clean.active, req.params.id
  );
  res.json(await findCode(v.clean.code));
});

discountsRouter.delete('/:id', requireRole('ADMIN'), async (req: AuthRequest, res) => {
  const existing = await row<DiscountCodeRow>('SELECT * FROM discount_codes WHERE id = ?', req.params.id);
  if (!existing) return res.status(404).json({ error: 'Discount code not found' });
  // Hard delete is safe: applied codes are snapshotted onto order_items.
  await run('DELETE FROM discount_codes WHERE id = ?', req.params.id);
  res.json({ deleted: existing.code });
});

/**
 * Compute the discount a code gives for one order line.
 * Returns { ok, code, code_discount_cents } or { ok: false, error }.
 */
export async function applyCodeToLine(
  codeRaw: string,
  itemName: string,
  qty: number,
  unitPriceCents: number
): Promise<{ ok: boolean; error?: string; code?: string; code_discount_cents?: number }> {
  const dc = await findCode(codeRaw);
  if (!dc) return { ok: false, error: 'Discount code not found' };
  if (!dc.active) return { ok: false, error: `Code ${dc.code} is inactive` };
  if (dc.menu_item_name && dc.menu_item_name.toLowerCase() !== String(itemName).trim().toLowerCase()) {
    return { ok: false, error: `Code ${dc.code} only applies to ${dc.menu_item_name}` };
  }
  const gross = qty * unitPriceCents;
  let disc = 0;
  if (dc.amount_cents) disc = dc.amount_cents * qty;
  else if (dc.percent_off) disc = Math.round((gross * dc.percent_off) / 100);
  disc = Math.min(disc, gross);
  return { ok: true, code: dc.code, code_discount_cents: disc };
}
