// Runs against `npm run dev`, or a draft deploy with BASE=https://<draft-url>.
// Overwrites the links and settings blobs of whichever store it hits, so against a deploy it
// needs ALLOW_OVERWRITE=1: that store holds the real links.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8888';
// The local blob sandbox checks-then-writes, so create-only writes can race there; the real store can't.
const LOCAL = BASE.includes('localhost');
if (!LOCAL && process.env.ALLOW_OVERWRITE !== '1') throw new Error('This replaces every link on that site. Run with ALLOW_OVERWRITE=1 if that is what you want.');
// Locally book one after another; remotely all at once to prove only `seats` people get in.
const race = async (jobs) => {
  if (!LOCAL) return Promise.all(jobs.map((job) => job()));
  const out = [];
  for (const job of jobs) out.push(await job());
  return out;
};
const run = Date.now().toString(36); // fresh slot ids per run so old seats don't interfere
const inDays = (d, h) => new Date(Date.now() + d * 864e5 + h * 36e5).toISOString();
const LINKS = [
  { id: `${run}a`, store: 'downtown', kind: 'single', slots: [
    { id: `${run}-solo`, start: inDays(2, 0), minutes: 15, seats: 1 },
    { id: `${run}-soon`, start: inDays(0, 1), minutes: 15, seats: 1 } // inside the 2h cutoff
  ] },
  { id: `${run}r`, store: 'riverside', kind: 'group', slots: [{ id: `${run}-group`, start: inDays(3, 0), minutes: 60, seats: 3 }] },
  { id: `${run}m`, store: 'hillcrest', kind: 'single', slots: [{ id: `${run}-other`, start: inDays(3, 1), minutes: 15, seats: 1 }] }
];
const LINK_OF = { solo: 'a', soon: 'a', group: 'r', other: 'm' };

const call = async (method, path, body) => {
  const res = await fetch(BASE + '/api/' + path, {
    method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body)
  });
  return { status: res.status, ...(await res.json()) };
};
const person = (i) => ({ firstName: 'Test', lastName: `P${i}`, phone: '5555550100', email: `p${i}-${run}@example.com` });
const seatsLeft = async (id) => {
  const name = id.slice(run.length + 1);
  return (await call('GET', `slots?link=${run}${LINK_OF[name]}`)).slots.find((s) => s.id === id)?.seatsLeft;
};

async function putBlob(name, value) {
  if (LOCAL) return call('PUT', name, value);
  writeFileSync(`.netlify/test-${name}.json`, JSON.stringify(value));
  execFileSync('npx', ['netlify', 'blobs:set', 'interviews', name, '--input', `.netlify/test-${name}.json`, '--force'], { stdio: 'inherit' });
}
// a high per-device limit: every booking here comes from one machine
await putBlob('settings', { rules: { maxBookingsPerHour: 1000 } });
await putBlob('links', LINKS);
assert.equal(await seatsLeft(`${run}-soon`), undefined, 'slot inside cutoff is hidden');

// a link shows only its own store and times; no or unknown link is refused
const downtown = await call('GET', `slots?link=${run}a`);
assert.equal(downtown.link.storeName, 'Downtown');
assert.match(downtown.link.address, /Main St/);
assert.deepEqual(downtown.slots.map((s) => s.id), [`${run}-solo`]);
assert.equal((await call('GET', 'slots')).status, 404);
assert.equal((await call('GET', 'slots?link=nope')).status, 404);

// 6 people race for 1 seat -> exactly one wins
const solo = await race([0, 1, 2, 3, 4, 5].map((i) => () => call('POST', 'book', { ...person(i), slotId: `${run}-solo` })));
assert.equal(solo.filter((r) => r.status === 200).length, 1, 'one booking for a 1-seat slot');
assert.equal(await seatsLeft(`${run}-solo`), 0);

// 5 people race for 3 seats -> exactly three win
const groupPeople = [10, 11, 12, 13, 14];
const group = await race(groupPeople.map((i) => () => call('POST', 'book', { ...person(i), slotId: `${run}-group` })));
const groupWins = group.filter((r) => r.status === 200);
const groupWinners = groupPeople.filter((_, k) => group[k].status === 200); // who won is random when concurrent
assert.equal(groupWins.length, 3, 'three bookings for a 3-seat slot');

// reschedule via token frees the old seat
const { token } = groupWins[0].booking;
const moved = await call('POST', 'book', { slotId: `${run}-other`, token });
assert.equal(moved.status, 200);
assert.equal(await seatsLeft(`${run}-group`), 1);
assert.equal(await seatsLeft(`${run}-other`), 0);

// cancel frees the seat
const cancelled = await call('POST', 'cancel', { token });
assert.equal(cancelled.booking.cancelled, true);
assert.equal(await seatsLeft(`${run}-other`), 1);

// same email with an upcoming booking is refused: only that booking's own link can move it
const sameEmail = await call('POST', 'book', { ...person(groupWinners[1]), firstName: 'Someone', slotId: `${run}-other` });
assert.equal(sameEmail.status, 409);
assert.match(sameEmail.error, /already have an interview booked/);
assert.equal(await seatsLeft(`${run}-group`), 1, 'their group seat is untouched');
assert.equal(await seatsLeft(`${run}-other`), 1, 'and no second seat was taken');
const again = await call('POST', 'book', { ...person(20), slotId: `${run}-other` });
assert.equal(again.status, 200);

// validation
const bad = await call('POST', 'book', { slotId: `${run}-group`, firstName: '', lastName: 'X', phone: '123', email: 'nope' });
assert.equal(bad.status, 400);
assert.deepEqual(Object.keys(bad.fields).sort(), ['email', 'firstName', 'phone']);

// a booking link shows only that booking
const looked = await call('GET', 'booking?t=' + again.booking.token);
assert.equal(looked.booking.storeName, 'Hillcrest');
assert.equal(looked.booking.link, `${run}m`, 'booking knows its link so the page can show that link’s times');
assert.equal(looked.booking.email, undefined, 'no email in public response');

// settings blob: page texts, store names and rules apply without an upload
assert.equal((await call('GET', 'page')).page.title, 'Job Interview', 'default page text');
await putBlob('settings', {
  page: { title: 'Team Interview' },
  stores: { downtown: { name: 'Downtown North', address: '1 Test St' }, riverside: { name: 'Riverside', address: '2 Test St' }, hillcrest: { name: 'Hillcrest', address: '3 Test St' } },
  rules: { maxDaysAhead: 1, maxBookingsPerHour: 1000 }
});
assert.equal((await call('GET', 'page')).page.title, 'Team Interview');
assert.equal((await call('GET', 'page')).page.host, 'Demo Company', 'unsaved fields keep their default');
const renamed = await call('GET', `slots?link=${run}a`);
assert.equal(renamed.link.storeName, 'Downtown North');
assert.equal(renamed.link.address, '1 Test St');
assert.deepEqual(renamed.slots, [], 'times further out than maxDaysAhead are hidden');
const outside = await call('POST', 'book', { ...person(30), slotId: `${run}-solo` });
assert.equal(outside.status, 409, 'and cannot be booked');
await putBlob('settings', { rules: { maxBookingsPerHour: 1 } });
const limited = await call('POST', 'book', { ...person(31), slotId: `${run}-group` });
assert.equal(limited.status, 429, 'per-device limit');
assert.match(limited.error, /Too many bookings from this device/);
await putBlob('settings', { rules: { cutoffHours: 80 } });
assert.equal(await seatsLeft(`${run}-group`), undefined, 'a longer cutoff hides times 3 days out');
await putBlob('settings', {});

console.log(LOCAL ? 'ok (sequential, local):' : 'ok (concurrent):', 'links, seat limits, reschedule, cancel, same-email refused, device limit, validation, manage link, settings');
