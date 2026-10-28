import { createHash, randomUUID } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { sendBookingEmail } from '../lib/email.mjs';
import { DEFAULTS, PLACEHOLDERS, mergeSettings } from '../lib/settings.mjs';
import { addDays, createLink, removeSlot } from '../lib/slots.mjs';
import {
  MAX_FAILED_LOGINS, adminPassword, cleanSettings, expiredBookings, passwordMatches, readCookie, sessionCookie, sessionCookieValue, sessionValid
} from '../lib/admin.mjs';

// Blob layout:
//   links                 [{ id, store, kind: 'single'|'group', createdAt, slots: [{ id, start (ISO), minutes, seats }] }]
//                         slot ids are unique across all links (seat keys use them)
//   seat/<slotId>/<n>     { token }  one key per taken seat, created with onlyIfNew so two people can't grab the same seat
//   booking/<token>       the booking record
//   email/<sha256>        token of that email's open booking
//   settings              stores, rules, page and email texts (see ../lib/settings.mjs)
//   rate/<sha256 of ip>   bookings per device this hour; adminfail/<sha256 of ip> failed admin logins

const db = () => getStore({ name: 'interviews', consistency: 'strong' });
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
// Booking tokens are 32 hex chars (randomUUID); anything else never reaches a blob key.
const isToken = (value) => /^[0-9a-f]{32}$/.test(String(value || ''));
const emailKey = (email) => 'email/' + createHash('sha256').update(email.trim().toLowerCase()).digest('hex');

async function loadLinks(store) {
  return (await store.get('links', { type: 'json' })) || [];
}

// Each slot carries its link's store and id, so a booking doesn't need the link to be shown.
const slotsOf = (links) => links.flatMap((l) => l.slots.map((s) => ({ ...s, store: l.store, link: l.id })));

async function takenSeats(store) {
  const { blobs } = await store.list({ prefix: 'seat/' });
  const taken = {};
  for (const { key } of blobs) {
    const slotId = key.slice(5, key.lastIndexOf('/'));
    taken[slotId] = (taken[slotId] || 0) + 1;
  }
  return taken;
}

const storeInfo = (settings, key) => settings.stores[key] || { name: key, address: '', note: '' };

function publicSlot(slot, seatsLeft, settings) {
  const s = storeInfo(settings, slot.store);
  return { id: slot.id, start: slot.start, minutes: slot.minutes, store: slot.store, storeName: s.name, address: s.address, seats: slot.seats, seatsLeft };
}

// Still open: more than cutoffHours away. Changing or cancelling only needs this.
const isOpen = (slot, rules) => Date.parse(slot.start) - Date.now() > rules.cutoffHours * 3600e3;
// Bookable: open, and inside the maxDaysAhead window when one is set.
const isBookable = (slot, rules) => isOpen(slot, rules) && (!rules.maxDaysAhead || Date.parse(slot.start) - Date.now() <= rules.maxDaysAhead * 864e5);

async function claimSeat(store, slot, token) {
  for (let n = 0; n < slot.seats; n++) {
    const key = `seat/${slot.id}/${n}`;
    if ((await store.setJSON(key, { token }, { onlyIfNew: true })).modified) return key;
  }
  return null;
}

function validate(body) {
  const firstName = String(body.firstName || '').trim().slice(0, 60);
  const lastName = String(body.lastName || '').trim().slice(0, 60);
  const email = String(body.email || '').trim().slice(0, 120);
  const phone = String(body.phone || '').trim().slice(0, 30);
  const errors = {};
  if (!firstName) errors.firstName = 'Enter your first name.';
  if (!lastName) errors.lastName = 'Enter your last name.';
  if (phone.replace(/\D/g, '').length < 10) errors.phone = 'Enter a 10-digit phone number.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Enter an email like name@example.com.';
  return { errors, person: { firstName, lastName, email, phone } };
}

async function listSlots(store, linkId, settings) {
  const [links, taken] = await Promise.all([loadLinks(store), takenSeats(store)]);
  const link = links.find((l) => l.id === linkId);
  if (!link) return json({ error: 'This link doesn’t work. Ask us for a new one.' }, 404);
  const s = storeInfo(settings, link.store);
  const open = slotsOf([link])
    .filter((slot) => isBookable(slot, settings.rules))
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .map((slot) => publicSlot(slot, Math.max(0, slot.seats - (taken[slot.id] || 0)), settings));
  return json({ link: { id: link.id, kind: link.kind, storeName: s.name, address: s.address }, slots: open });
}

async function getBooking(store, token, settings) {
  const booking = isToken(token) && (await store.get(`booking/${token}`, { type: 'json' }));
  if (!booking) return json({ error: 'Booking not found.' }, 404);
  const slot = slotsOf(await loadLinks(store)).find((s) => s.id === booking.slotId);
  return json({ booking: publicBooking(booking, slot, settings) });
}

function publicBooking(booking, slot, settings) {
  const s = storeInfo(settings, booking.store);
  return {
    token: booking.token, link: booking.link, slotId: booking.slotId, start: booking.start, minutes: booking.minutes, seats: booking.seats,
    store: booking.store, storeName: s.name, address: s.address, firstName: booking.firstName,
    cancelled: Boolean(booking.cancelledAt), changeable: !booking.cancelledAt && (!slot || isOpen(slot, settings.rules))
  };
}

// One counter per device and hour. shortcut: read-then-write, so a burst of parallel requests can
// slip a few past the limit; fine against spam, upgrade to a seat-style onlyIfNew key if it matters.
async function rateCount(store, ip, prefix = 'rate/') {
  const key = prefix + createHash('sha256').update(String(ip)).digest('hex');
  const hour = Math.floor(Date.now() / 3600e3);
  const saved = await store.get(key, { type: 'json' });
  const count = saved?.hour === hour ? saved.count : 0;
  return { count, add: () => store.setJSON(key, { hour, count: count + 1 }) };
}

async function book(store, body, origin, settings, ip) {
  if (body.website) return json({ error: 'Something went wrong.' }, 400); // honeypot
  const rate = await rateCount(store, ip);
  if (rate.count >= settings.rules.maxBookingsPerHour) return json({ error: 'Too many bookings from this device. Try again in an hour.' }, 429);
  const slot = slotsOf(await loadLinks(store)).find((s) => s.id === body.slotId);
  if (!slot || !isBookable(slot, settings.rules)) return json({ error: 'That time is no longer available. Pick another one.' }, 409);

  // Rescheduling: explicit token from the manage link, or the email already has an open booking.
  let old = isToken(body.token) ? await store.get(`booking/${body.token}`, { type: 'json' }) : null;
  if (old?.cancelledAt) old = null;
  let person;
  if (old) {
    person = { firstName: old.firstName, lastName: old.lastName, email: old.email, phone: old.phone };
  } else {
    const { errors, person: p } = validate(body);
    if (Object.keys(errors).length) return json({ error: 'Check the highlighted fields.', fields: errors }, 400);
    person = p;
    // shortcut: two simultaneous bookings with the same email can both get through; fine at our volume.
    // An upcoming booking for this email is changed only through its own link: knowing someone's
    // email must not be enough to move their interview.
    const openToken = await store.get(emailKey(person.email), { type: 'text' });
    const existing = openToken && (await store.get(`booking/${openToken}`, { type: 'json' }));
    if (existing && !existing.cancelledAt && Date.parse(existing.start) > Date.now()) {
      return json({ error: 'You already have an interview booked. Use the link in your confirmation email to change it.' }, 409);
    }
  }
  if (old && old.slotId === slot.id) return json({ booking: publicBooking(old, slot, settings) });

  const token = old?.token || randomUUID().replace(/-/g, '');
  const seatKey = await claimSeat(store, slot, token);
  if (!seatKey) return json({ error: 'That time just filled up. Pick another one.' }, 409);

  const now = new Date().toISOString();
  const booking = {
    ...person, token, link: slot.link, slotId: slot.id, start: slot.start, minutes: slot.minutes, seats: slot.seats, store: slot.store, seatKey,
    createdAt: old?.createdAt || now, updatedAt: now, cancelledAt: null,
    history: old ? [...(old.history || []), { slotId: old.slotId, start: old.start, movedAt: now }] : []
  };
  await store.setJSON(`booking/${token}`, booking);
  await store.set(emailKey(person.email), token);
  if (old?.seatKey) await store.delete(old.seatKey); // free the old seat only after the new one is safely held
  await rate.add();
  const pub = publicBooking(booking, slot, settings);
  await sendBookingEmail(old ? 'moved' : 'booked', booking.email, pub, origin, settings);
  return json({ booking: pub });
}

async function cancel(store, token, origin, settings) {
  const booking = isToken(token) && (await store.get(`booking/${token}`, { type: 'json' }));
  if (!booking) return json({ error: 'Booking not found.' }, 404);
  if (!booking.cancelledAt) {
    booking.cancelledAt = new Date().toISOString();
    await store.setJSON(`booking/${token}`, booking);
    await store.delete(booking.seatKey);
    await store.delete(emailKey(booking.email));
    await sendBookingEmail('cancelled', booking.email, publicBooking(booking, null, settings), origin, settings);
  }
  return json({ booking: publicBooking(booking, null, settings) });
}

// ---- Admin (/admin) -------------------------------------------------------------------------
// Every admin route but login needs the session cookie (see ../lib/admin.mjs). Only the admin
// sees applicants' phone numbers and emails.

async function loadBookings(store) {
  const { blobs } = await store.list({ prefix: 'booking/' });
  return (await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' })))).filter(Boolean);
}

// Names, phones and emails don't stay forever: a booking goes retentionDays after its interview,
// with its seat and its email entry (when that still points at it). Returns the rest.
async function purgeOldBookings(store, bookings, retentionDays) {
  const expired = expiredBookings(bookings, retentionDays);
  for (const booking of expired) {
    if (booking.seatKey) await store.delete(booking.seatKey);
    if ((await store.get(emailKey(booking.email), { type: 'text' })) === booking.token) await store.delete(emailKey(booking.email));
    await store.delete(`booking/${booking.token}`);
  }
  return bookings.filter((booking) => !expired.includes(booking));
}

const adminBooking = (b) => ({
  token: b.token, link: b.link, slotId: b.slotId, start: b.start, firstName: b.firstName, lastName: b.lastName,
  email: b.email, phone: b.phone, createdAt: b.createdAt, cancelledAt: b.cancelledAt
});

async function adminOverview(store, settings) {
  const [links, all] = await Promise.all([loadLinks(store), loadBookings(store)]);
  const bookings = await purgeOldBookings(store, all, settings.rules.retentionDays);
  return json({ links, bookings: bookings.map(adminBooking), settings, defaults: DEFAULTS, placeholders: PLACEHOLDERS });
}

async function adminLogin(store, body, origin, ip, password) {
  const failures = await rateCount(store, ip, 'adminfail/');
  if (failures.count >= MAX_FAILED_LOGINS) return json({ error: 'Too many wrong passwords. Try again in an hour.' }, 429);
  if (!passwordMatches(String(body.password || ''), password)) {
    await failures.add();
    await new Promise((resolve) => setTimeout(resolve, 1000)); // slows down guessing
    return json({ error: 'Wrong password.' }, 401);
  }
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(sessionCookieValue(password), origin) });
}

// shortcut: read-modify-write of the links blob, so two admins saving in the same second can lose one change; fine for one owner.
async function updateLink(store, linkId, change) {
  const links = await loadLinks(store);
  const index = links.findIndex((link) => link.id === linkId);
  if (index === -1) throw new Error('That link is gone. Reload the page.');
  links[index] = await change(links[index]);
  await store.setJSON('links', links);
  return links[index];
}

async function admin(req, store, route, origin, settings, ip) {
  const password = adminPassword();
  if (!password) return json({ error: 'The admin is off. Set ADMIN_PASSWORD in the site settings.' }, 503);
  // JSON only: a plain form from another site can't send it without a preflight, which never passes.
  if (req.method === 'POST' && req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') return json({ error: 'Send JSON.' }, 415);
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

  if (req.method === 'POST' && route === 'login') return adminLogin(store, body, origin, ip, password);
  if (req.method === 'POST' && route === 'logout') return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', origin, 0) });
  if (!sessionValid(readCookie(req.headers.get('cookie'), 'admin_session'), password)) return json({ error: 'Sign in first.' }, 401);

  try {
    if (req.method === 'GET' && route === 'overview') return await adminOverview(store, settings);
    if (req.method === 'POST' && route === 'links') {
      const link = createLink({ store: body.store, kind: body.kind, days: body.days }, Object.keys(settings.stores));
      await store.setJSON('links', [...(await loadLinks(store)), link]);
      return json({ link });
    }
    if (req.method === 'POST' && route === 'links/days') return json({ link: await updateLink(store, body.linkId, (link) => addDays(link, body.days)) });
    if (req.method === 'POST' && route === 'slots/remove') {
      const bookings = await loadBookings(store);
      return json({ link: await updateLink(store, body.linkId, (link) => removeSlot(link, body.slotId, bookings)) });
    }
    // The applicant gets the usual cancellation email with a link to pick a new time.
    if (req.method === 'POST' && route === 'bookings/cancel') return await cancel(store, String(body.token || ''), origin, settings);
    if (req.method === 'POST' && route === 'settings') {
      const saved = (await store.get('settings', { type: 'json' })) || {};
      await store.setJSON('settings', cleanSettings(body, await loadLinks(store), mergeSettings(saved)));
      return await adminOverview(store, mergeSettings(await store.get('settings', { type: 'json' })));
    }
  } catch (err) {
    // Admin errors are the owner's own input (a missing date, a booked time), so say what's wrong.
    return json({ error: err.message }, 400);
  }
  return json({ error: 'Not found.' }, 404);
}

export default async (req, context) => {
  const store = db();
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\//, '');
  try {
    const settings = mergeSettings((await store.get('settings', { type: 'json' })) || {});
    if (req.method === 'GET' && route === 'page') return json({ page: settings.page });
    if (req.method === 'GET' && route === 'slots') return await listSlots(store, url.searchParams.get('link'), settings);
    if (req.method === 'GET' && route === 'booking') return await getBooking(store, url.searchParams.get('t'), settings);
    if (req.method === 'POST' && ['book', 'cancel'].includes(route)) {
      const body = await req.json().catch(() => ({}));
      const origin = url.origin; // links in the email point back at whichever deploy was booked
      if (route === 'book') return await book(store, body, origin, settings, context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown');
      return await cancel(store, String(body.token || ''), origin, settings);
    }
    if (route.startsWith('admin/')) {
      return await admin(req, store, route.slice(6), url.origin, settings, context?.ip || req.headers.get('x-nf-client-connection-ip') || 'unknown');
    }
    // shortcut: local seeding only (scripts/seed.mjs); in production write the blobs with `netlify blobs:set`.
    if (req.method === 'PUT' && (route === 'links' || route === 'settings') && process.env.NETLIFY_DEV === 'true') {
      await store.setJSON(route, await req.json());
      return json({ ok: true });
    }
    return json({ error: 'Not found.' }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: 'Something went wrong. Try again in a minute.' }, 500);
  }
};

export const config = { path: '/api/*' };
