import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { env } from '../config/env.js';
import type { Principal, RoviqRole } from '../types/principal.js';

const secret = new TextEncoder().encode(env.JWT_SECRET);

export function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

export function verifyPassword(password: string, salt: string, expectedHash: string) {
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A fixed salt/hash pair to run verifyPassword's real cost against when no identity was found,
// so a request for a non-existent email takes the same time as one for a real email with a wrong
// password -- otherwise the missing-scrypt-call path is a user-enumeration timing side-channel.
const DUMMY_SALT = 'e3b0c44298fc1c149afbf4c8996fb924';
const DUMMY_HASH = scryptSync('dummy-password-for-constant-time-login',DUMMY_SALT,64).toString('hex');
export function verifyPasswordConstantTime(password: string, salt?: string | null, expectedHash?: string | null) {
  if (!salt || !expectedHash) { verifyPassword(password, DUMMY_SALT, DUMMY_HASH); return false; }
  return verifyPassword(password, salt, expectedHash);
}

export async function issueAccessToken(identityId: string, principal: Principal) {
  return new SignJWT({ role: principal.role, actorId: principal.actorId })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(identityId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(env.JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<Principal & { identityId: string }> {
  const { payload } = await jwtVerify(token, secret, { issuer: env.JWT_ISSUER, audience: env.JWT_AUDIENCE });
  const role = payload.role as RoviqRole;
  const actorId = typeof payload.actorId === 'string' ? payload.actorId : undefined;
  if (!payload.sub || !role) throw new Error('invalid_token_payload');
  if (role !== 'admin' && !actorId) throw new Error('invalid_token_actor');
  return { identityId: payload.sub, role, actorId };
}
