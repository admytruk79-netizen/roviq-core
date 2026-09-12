import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const service=readFileSync(new URL('./financial-reconciliation.ts',import.meta.url),'utf8');
const routes=readFileSync(new URL('../http/routes/payments.ts',import.meta.url),'utf8');
const migration=readFileSync(new URL('../../migrations/050_payment_provider_uniqueness.sql',import.meta.url),'utf8');
const ops=readFileSync(new URL('../../ops/src/pages/FinancialOperations.tsx',import.meta.url),'utf8');

describe('financial truth invariants',()=>{
  it('detects capture, refund and payout ledger drift',()=>{
    expect(service).toContain("payment_capture_ledger_mismatch");
    expect(service).toContain("payment_refund_ledger_mismatch");
    expect(service).toContain("payout_ledger_mismatch");
    expect(service).toContain("payout_linked_to_uncaptured_payment");
  });

  it('requires provider references for provider-backed money movement',()=>{
    expect(service).toContain("payment_provider_reference_missing");
    expect(service).toContain("payout_provider_reference_missing");
    expect(migration).toContain('settlement_payouts_provider_ref_uidx');
    expect(migration).toContain('where provider_payout_id is not null');
  });

  it('exposes reconciliation only through the admin financial route',()=>{
    expect(routes).toContain("/api/admin/financial-reconciliation");
    expect(routes).toContain("preHandler: requireRole('admin')");
    expect(routes).toContain('getFinancialReconciliation(req.principal,query.limit)');
  });

  it('keeps the Ops UI explicit that internal consistency is not provider settlement truth',()=>{
    expect(ops).toContain('live provider settlement still requires provider-side reconciliation');
    expect(ops).toContain('/api/admin/financial-reconciliation?limit=500');
  });
});
