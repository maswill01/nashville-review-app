// Passwords and session cookies. No database and no Express in here: this file is
// the crypto, `server.js` owns the SQL and the routes.

import crypto from 'node:crypto';

const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

export const SESSION_SECRET_SET = Boolean(process.env.SESSION_SECRET);
export const COOKIE_NAME = 'nra_auth';
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 60; // 60 days — stay logged in on your phone

/* -------------------------------- passwords ------------------------------- */

// scrypt, out of the standard library. bcrypt and argon2 are both native modules,
// and this project's two-dependency ceiling is worth more than their marginally
// better memory-hardness for a list of restaurants behind an invite code.
// N=16384, r=8 costs ~16MB and ~60ms per hash, which is the point.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function scryptKey(password, salt, keylen, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, params, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export async function hashPassword(password) {
  const { N, r, p, keylen } = SCRYPT;
  const salt = crypto.randomBytes(16);
  const key = await scryptKey(password, salt, keylen, { N, r, p });
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const [, N, r, p, saltB64, keyB64] = parts;
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(keyB64, 'base64');
  if (!expected.length) return false;

  const actual = await scryptKey(password, salt, expected.length, {
    N: Number(N), r: Number(r), p: Number(p)
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// A wrong username and a wrong password should cost the same wall-clock time, or
// the login form answers "does this person have an account here?" by stopwatch.
const DUMMY_HASH = await hashPassword(crypto.randomBytes(16).toString('hex'));

export function burnPasswordTime() {
  return verifyPassword('no-such-user', DUMMY_HASH);
}

/* --------------------------------- sessions ------------------------------- */

function hmac(body) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('hex');
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// `<id>.<token_version>.<hmac>`. There is still no session table — the signature
// is the session. Bumping a user's token_version invalidates every cookie they
// hold, which is the only way to sign a lost phone out remotely.
export function signSession(user) {
  const body = `${user.id}.${user.token_version}`;
  return `${body}.${hmac(body)}`;
}

export function readSession(raw) {
  const value = String(raw || '');
  const cut = value.lastIndexOf('.');
  if (cut < 1) return null;

  const body = value.slice(0, cut);
  if (!safeEqual(value.slice(cut + 1), hmac(body))) return null;

  const [id, tokenVersion] = body.split('.');
  if (!/^\d+$/.test(id) || !/^\d+$/.test(tokenVersion)) return null;
  return { id: Number(id), tokenVersion: Number(tokenVersion) };
}

export function readCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = decodeURIComponent(trimmed.slice(eq + 1));
  }
  return out;
}

export function setAuthCookie(req, res, value, maxAge) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.secure;
  const bits = [`${COOKIE_NAME}=${value}`, 'HttpOnly', 'Path=/', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) bits.push('Secure');
  res.setHeader('Set-Cookie', bits.join('; '));
}

/* --------------------------------- throttle ------------------------------- */

// One shared password that only the owner knew did not need this. Several accounts
// with friend-chosen passwords on a public URL do. In memory on purpose: a restart
// clearing the counters is not a threat worth a table.
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map();

function prune(now) {
  for (const [key, entry] of attempts) {
    if (now - entry.first > WINDOW_MS) attempts.delete(key);
  }
}

export function throttled(key) {
  const now = Date.now();
  prune(now);
  const entry = attempts.get(key);
  return Boolean(entry) && entry.count >= MAX_ATTEMPTS;
}

export function recordFailure(key) {
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.first > WINDOW_MS) attempts.set(key, { first: now, count: 1 });
  else entry.count += 1;
}

export function clearFailures(key) {
  attempts.delete(key);
}
