// Fills the local blob store with demo links for the next two weeks. Run while `npm run dev` is up:
//   npm run seed
// Prints one booking URL per link. Starts from an empty store, so old bookings and rate limits are gone.
import { rmSync } from 'node:fs';
import { createLink } from '../netlify/lib/slots.mjs';
import { DEFAULTS } from '../netlify/lib/settings.mjs';

const BASE = process.env.BASE || 'http://localhost:8888';
if (!BASE.includes('localhost')) throw new Error('Seeding only runs against the local dev server.');

const stores = Object.keys(DEFAULTS.stores);
const dateKey = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const day = (offset) => dateKey.format(new Date(Date.now() + offset * 864e5));
const weekdays = [1, 2, 3, 4, 5, 8, 9, 10, 11, 12].map(day);

const links = [
  createLink({ store: 'downtown', kind: 'single', days: weekdays.map((date) => ({ date, from: '14:00', to: '16:00' })) }, stores),
  createLink({ store: 'riverside', kind: 'single', days: weekdays.filter((_, i) => i % 2).map((date) => ({ date, from: '10:00', to: '11:30' })) }, stores),
  createLink({ store: 'hillcrest', kind: 'group', days: [6, 13].map((d) => ({ date: day(d), time: '10:00', seats: 12, minutes: 120 })) }, stores)
];

async function put(name, value) {
  const res = await fetch(`${BASE}/api/${name}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
  if (!res.ok) throw new Error(`PUT ${name} failed: ${res.status}. Is \`npm run dev\` running?`);
}

// shortcut: deletes netlify dev's local blob folder directly; update the path if the CLI moves it.
rmSync(new URL('../.netlify/blobs-serve', import.meta.url), { recursive: true, force: true });
await put('settings', {});
await put('links', links);
for (const link of links) console.log(`${DEFAULTS.stores[link.store].name} (${link.kind}, ${link.slots.length} slots): ${BASE}/i/${link.id}`);
console.log(`Admin: ${BASE}/admin/ (password "demo" unless ADMIN_PASSWORD is set)`);
