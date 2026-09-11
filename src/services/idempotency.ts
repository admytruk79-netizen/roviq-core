import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool } from '../db/pool.js';
import type { Principal } from '../types/principal.js';

export async function withIdempotency<T>(
  principal: Principal,
  key: string | undefined,
  operation: string,
  body: unknown,
  fn: (transactionClient?:PoolClient) => Promise<{ status:number; body:T }>
) {
  if (!key) return fn();
  if (key.length > 200) throw new Error('idempotency_key_too_long');

  const actorScope = principal.actorId ?? 'anonymous';
  const scopedKey = createHash('sha256')
    .update(`${principal.role}|${actorScope}|${operation}|${key}`)
    .digest('hex');
  const requestHash = createHash('sha256').update(stableJson(body ?? null)).digest('hex');
  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query(
      `insert into idempotency_keys(key,principal_role,principal_actor_id,operation,request_hash)
       values($1,$2,$3,$4,$5) on conflict(key) do nothing`,
      [scopedKey,principal.role,principal.actorId ?? null,operation,requestHash]
    );

    const existing = await client.query(
      `select principal_role,principal_actor_id,operation,request_hash,response_code,response_body,expires_at
         from idempotency_keys
        where key=$1
        for update`,
      [scopedKey]
    );
    const row = existing.rows[0];
    const expired = row.expires_at && new Date(row.expires_at).getTime() <= Date.now();

    if (expired) {
      await client.query(
        `update idempotency_keys
            set principal_role=$1,principal_actor_id=$2,operation=$3,request_hash=$4,
                response_code=null,response_body=null,created_at=now(),expires_at=now()+interval '24 hours'
          where key=$5`,
        [principal.role,principal.actorId ?? null,operation,requestHash,scopedKey]
      );
    } else if (
      row.request_hash !== requestHash ||
      row.operation !== operation ||
      row.principal_role !== principal.role ||
      (row.principal_actor_id ?? null) !== (principal.actorId ?? null)
    ) {
      throw new Error('idempotency_key_reused');
    } else if (row.response_code !== null) {
      await client.query('commit');
      return {status:row.response_code,body:row.response_body as T};
    }

    const result = await fn(client);
    await client.query(
      'update idempotency_keys set response_code=$1,response_body=$2 where key=$3',
      [result.status,JSON.stringify(result.body),scopedKey]
    );
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function stableJson(value:unknown):string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string,unknown>;
    return `{${Object.keys(record).sort().map((key)=>`${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
