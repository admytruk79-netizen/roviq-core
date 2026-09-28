import { pool } from '../db/pool.js';

export type InventoryMatch = {
  id: string; vin: string; year: number | null; make: string; model: string; trim: string | null;
  condition: string | null; mileage: number | null; public_price_cents: number | null; source_price_cents: number | null;
  source_dealer_name: string | null; source_dealer_url: string | null; last_seen_at: Date | string; available: boolean;
};

export const vehicleTitle = (v: Pick<InventoryMatch, 'year' | 'make' | 'model' | 'trim'>) =>
  [v.year, v.make, v.model, v.trim].filter(Boolean).join(' ');

// Latest record for a VIN; "available" means the dealer still listed it in the last 24 hours.
export async function findInventoryByVin(vin: string): Promise<InventoryMatch | null> {
  const r = await pool.query(`
    select id,vin,year,make,model,trim,condition,mileage,public_price_cents::int as public_price_cents,
           source_price_cents::int as source_price_cents,source_dealer_name,source_dealer_url,last_seen_at,
           (status='active' and last_seen_at >= now() - interval '24 hours') as available
    from vehicle_inventory where upper(vin)=upper($1)
    order by (status='active' and last_seen_at >= now() - interval '24 hours') desc, last_seen_at desc limit 1`, [vin]);
  return r.rows[0] ?? null;
}

const dollars = (cents: number | null | undefined) =>
  cents == null ? 'not listed' : `$${Math.round(Number(cents) / 100).toLocaleString('en-US')}`;

export function ownerEmail(input: { name: string; email: string; phone?: string | null; note?: string | null; vin: string }, v: InventoryMatch | null, requestId: string) {
  const title = v ? vehicleTitle(v) : 'Unknown vehicle';
  const lines = [
    `New truck request ${requestId}`,
    '',
    `Truck: ${title}${v?.condition ? ` (${v.condition})` : ''}`,
    `VIN: ${input.vin}`,
    `Availability: ${v?.available ? 'AVAILABLE' : 'NOT CURRENTLY LISTED'}${v ? ` (dealer last listed it ${new Date(v.last_seen_at).toISOString()})` : ''}`,
    `Price quoted on ROVIQ: ${dollars(v?.public_price_cents)}`,
    `Dealer price: ${dollars(v?.source_price_cents)}`,
    `Dealer: ${v?.source_dealer_name ?? 'unknown'}`,
    `Dealer listing: ${v?.source_dealer_url ?? 'not available'}`,
    `Mileage: ${v?.mileage != null ? `${v.mileage.toLocaleString('en-US')} mi` : 'not listed'}`,
    '',
    `Customer: ${input.name}`,
    `Email: ${input.email}`,
    `Phone: ${input.phone || 'not given'}`,
    `Message: ${input.note || '(none)'}`
  ];
  return { email: input.email, subject: `Truck request: ${title} — VIN ${input.vin}`.slice(0, 200), message: lines.join('\n') };
}

// Emails the owner through Core's Resend account. Off until RESEND_API_KEY,
// RESEND_FROM_EMAIL and OWNER_NOTIFY_EMAIL are set; requests are stored either way.
export async function notifyOwner(payload: ReturnType<typeof ownerEmail>, fetcher: typeof fetch = fetch): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  const to = process.env.OWNER_NOTIFY_EMAIL;
  if (!apiKey || !from || !to) return false;
  try {
    const res = await fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], reply_to: payload.email, subject: payload.subject, text: payload.message }),
      signal: AbortSignal.timeout(15000)
    });
    return res.ok;
  } catch { return false; }
}

export async function createVehicleInquiry(
  input: { vin: string; name: string; email: string; phone?: string | null; note?: string | null },
  clientIp: string, fetcher: typeof fetch = fetch
) {
  const recent = await pool.query(
    `select count(*)::int as count from vehicle_inquiries where client_ip=$1 and created_at >= now() - interval '10 minutes'`, [clientIp]);
  if (Number(recent.rows[0]?.count ?? 0) >= 5) return { rateLimited: true as const };
  const v = await findInventoryByVin(input.vin);
  const inserted = await pool.query(`
    insert into vehicle_inquiries(vin,vehicle_inventory_id,customer_name,customer_email,customer_phone,note,available_at_request,
      quoted_price_cents,source_price_cents,dealer_name,dealer_url,vehicle_title,client_ip)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [input.vin.toUpperCase(), v?.id ?? null, input.name, input.email, input.phone || null, input.note || null, Boolean(v?.available),
     v?.public_price_cents ?? null, v?.source_price_cents ?? null, v?.source_dealer_name ?? null, v?.source_dealer_url ?? null,
     v ? vehicleTitle(v) : null, clientIp]);
  const id: string = inserted.rows[0].id;
  const notified = await notifyOwner(ownerEmail(input, v, id), fetcher);
  if (notified) await pool.query(`update vehicle_inquiries set owner_notified=true where id=$1`, [id]);
  return { rateLimited: false as const, id, available: Boolean(v?.available), lastSeenAt: v?.last_seen_at ?? null, notified };
}
