export function formatMinorAmount(amountMinor: number | null, currency: string | null) {
  if (amountMinor == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency ?? 'USD' }).format(amountMinor / 100);
}

export function formatAmount(amount: string | number, currency: string) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount));
}

export function formatDateTime(value: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function humanizeToken(value: string) {
  return value.toLowerCase().replace(/_/g, ' ');
}
