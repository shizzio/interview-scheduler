import assert from 'node:assert/strict';
import test from 'node:test';
import {
  adminPassword, passwordMatches, sessionCookieValue, sessionValid, readCookie, sessionCookie, cleanSettings, expiredBookings, SESSION_HOURS
} from '../netlify/lib/admin.mjs';

test('admin password: env wins, netlify dev falls back to "demo", a deployed site without one has no admin', () => {
  assert.equal(adminPassword({ ADMIN_PASSWORD: 's3cret', NETLIFY_DEV: 'true' }), 's3cret');
  assert.equal(adminPassword({ NETLIFY_DEV: 'true' }), 'demo');
  assert.equal(adminPassword({}), null);
  assert.equal(passwordMatches('s3cret', 's3cret'), true);
  assert.equal(passwordMatches('s3cret ', 's3cret'), false);
  assert.equal(passwordMatches('anything', null), false);
});

test('session cookie: valid until expiry, bound to the password, tamper-proof', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const value = sessionCookieValue('pw', now);
  assert.equal(sessionValid(value, 'pw', now + 60e3), true);
  assert.equal(sessionValid(value, 'pw', now + SESSION_HOURS * 3600e3 + 1), false, 'expired');
  assert.equal(sessionValid(value, 'other', now), false, 'a new password signs everyone out');
  const [expiry, mac] = value.split('.');
  assert.equal(sessionValid(`${Number(expiry) + 864e5}.${mac}`, 'pw', now), false, 'a longer expiry breaks the signature');
  assert.equal(sessionValid('', 'pw', now), false);
  assert.equal(sessionValid('123.zz', 'pw', now), false);
  assert.equal(readCookie(`a=1; admin_session=${value}; b=2`, 'admin_session'), value);
  assert.match(sessionCookie('x', 'https://example.org'), /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  assert.doesNotMatch(sessionCookie('x', 'http://localhost:8888'), /Secure/);
});

const form = (overrides = {}) => ({
  stores: [{ key: 'downtown', name: 'Downtown', address: '100 Main St' }],
  rules: { cutoffHours: 2, maxDaysAhead: 0, calendarMinutes: 60, maxBookingsPerHour: 5, retentionDays: 90 },
  page: { host: '  Acme  ' },
  email: {},
  ...overrides
});

test('settings: cleaned, limits enforced, locations with links stay', () => {
  const saved = cleanSettings(form(), []);
  assert.deepEqual(saved.stores, { downtown: { name: 'Downtown', address: '100 Main St', note: '' } });
  assert.equal(saved.page.host, 'Acme');
  assert.equal(saved.page.title, '', 'blank stays blank, so the default applies');
  const added = cleanSettings(form({ stores: [...form().stores, { name: 'North Side', address: '1 North Rd' }] }), []);
  assert.ok(added.stores['north-side'], 'a new location gets a key from its name');
  assert.throws(() => cleanSettings(form({ stores: [{ name: 'X', address: '' }] }), []), /name and an address/);
  assert.throws(() => cleanSettings(form({ stores: [] }), []), /at least one location/);
  assert.throws(() => cleanSettings(form({ rules: { ...form().rules, retentionDays: 5 } }), []), /30 to 365/);
  assert.throws(() => cleanSettings(form({ email: { bookedSubject: 'x'.repeat(151) } }), []), /too long/);
  const links = [{ store: 'riverside' }];
  assert.throws(() => cleanSettings(form(), links, { stores: { riverside: { name: 'Riverside' } } }), /Riverside still has interview links/);
});

test('retention: only bookings whose interview is older than retentionDays', () => {
  const now = Date.parse('2026-10-29T12:00:00Z');
  const old = { start: '2026-07-30T10:00:00-07:00' };
  const recent = { start: '2026-08-15T10:00:00-07:00' };
  assert.deepEqual(expiredBookings([old, recent], 90, now), [old]);
});
