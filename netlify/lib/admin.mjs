// The admin side (/admin): who may use it, and what it may save. Pure functions, so they're
// testable without a server; the routes live in ../functions/api.mjs.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DEFAULTS } from './settings.mjs';

export const SESSION_HOURS = 12;
export const MAX_FAILED_LOGINS = 10; // per device and hour

// ADMIN_PASSWORD from the site's environment. `netlify dev` without one gets "demo", so the
// demo works out of the box; a deployed site without one has no admin at all.
export function adminPassword(env = process.env) {
  if (env.ADMIN_PASSWORD) return env.ADMIN_PASSWORD;
  return env.NETLIFY_DEV === 'true' ? 'demo' : null;
}

const digest = (value) => createHash('sha256').update(String(value)).digest();

export function passwordMatches(given, expected) {
  return Boolean(expected) && timingSafeEqual(digest(given), digest(expected));
}

// The session cookie is "<expiry ms>.<hmac>". The key comes from the password, so changing
// ADMIN_PASSWORD signs everyone out.
const sessionKey = (password) => createHmac('sha256', 'interview-admin-session').update(password).digest();
const sign = (expiry, password) => createHmac('sha256', sessionKey(password)).update(String(expiry)).digest('hex');

export function sessionCookieValue(password, now = Date.now()) {
  const expiry = now + SESSION_HOURS * 3600e3;
  return `${expiry}.${sign(expiry, password)}`;
}

export function sessionValid(value, password, now = Date.now()) {
  const [expiry, mac] = String(value || '').split('.');
  if (!password || !/^\d+$/.test(expiry || '') || !/^[0-9a-f]{64}$/.test(mac || '') || Number(expiry) < now) return false;
  return timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(sign(expiry, password), 'hex'));
}

export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

// HttpOnly so page scripts can't read it, SameSite=Strict so other sites can't use it, scoped to
// the admin API. Secure everywhere but plain-http localhost (netlify dev).
export function sessionCookie(value, origin, maxAge = SESSION_HOURS * 3600) {
  const secure = origin.startsWith('https:') ? '; Secure' : '';
  return `admin_session=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

const textLimit = (key) => (/Subject$/.test(key) ? 150 : 300);
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'store';

export const RULE_RANGES = {
  cutoffHours: [0, 72, 'Booking closes'],
  maxDaysAhead: [0, 90, 'Show times up to'],
  calendarMinutes: [15, 240, 'Calendar entry'],
  maxBookingsPerHour: [1, 50, 'Bookings per device'],
  retentionDays: [30, 365, 'Delete bookings after']
};

// The settings form -> the blob the booking page reads. Blank texts stay blank (the page then
// uses the default); locations keep their key so existing links and bookings still find them.
export function cleanSettings(input, links, previous = {}) {
  const stores = {};
  for (const row of Array.isArray(input?.stores) ? input.stores : []) {
    const name = String(row?.name || '').trim();
    const address = String(row?.address || '').trim();
    if (!name && !address) continue;
    if (!name || !address) throw new Error('Every location needs a name and an address.');
    if (name.length > 40 || address.length > 120) throw new Error(`Shorten the name or address of ${name}.`);
    let key = /^[a-z0-9-]{1,30}$/.test(row?.key || '') ? row.key : slug(name);
    while (!row?.key && stores[key]) key = `${key}-2`;
    stores[key] = { name, address, note: String(row?.note || '').trim().slice(0, 200) };
  }
  if (!Object.keys(stores).length) throw new Error('Keep at least one location.');
  const removed = [...new Set(links.map((link) => link.store))].filter((key) => !stores[key]);
  if (removed.length) {
    const name = previous.stores?.[removed[0]]?.name || DEFAULTS.stores[removed[0]]?.name || removed[0];
    throw new Error(`${name} still has interview links, so it can't be removed.`);
  }
  const rules = {};
  for (const [key, [min, max, label]] of Object.entries(RULE_RANGES)) {
    const value = Number(input?.rules?.[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} has to be a whole number from ${min} to ${max}.`);
    rules[key] = value;
  }
  const texts = (section) => Object.fromEntries(Object.keys(DEFAULTS[section]).map((key) => {
    const value = String(input?.[section]?.[key] ?? '').trim();
    if (value.length > textLimit(key)) throw new Error(`${key} is too long (${textLimit(key)} characters at most).`);
    return [key, value];
  }));
  return { stores, rules, page: texts('page'), email: texts('email') };
}

// Bookings whose interview is more than retentionDays ago; their names, phones and emails go.
export const expiredBookings = (bookings, retentionDays, now = Date.now()) =>
  bookings.filter((booking) => Date.parse(booking.start) < now - retentionDays * 864e5);
