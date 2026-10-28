// Interview links: a link belongs to one store and is either one-on-one (15-minute slots) or a
// group (one slot with several seats). scripts/seed.mjs uses this to write the `links` blob.
import { randomBytes } from 'node:crypto';

const interviewKinds = ['single', 'group'];
const interviewTimeZone = 'America/Los_Angeles';
const singleSlotMinutes = 15;

const wallClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: interviewTimeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

// "2026-10-27" + "14:00" -> "2026-10-27T14:00:00-07:00", picking PDT or PST for that date.
export function pacificIso(date, time) {
  for (const offset of ['-07:00', '-08:00']) {
    const iso = `${date}T${time}:00${offset}`;
    if (wallClock.format(new Date(iso)) === `${date}, ${time}`) return iso;
  }
  throw new Error(`${date} ${time} doesn't exist in Pacific time.`);
}

const toMinutes = (time) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const toTime = (minutes) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

function checkDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day?.date || '')) throw new Error('Pick a date for every day.');
  for (const field of ['from', 'to', 'time']) {
    if (field in day && !/^([01]\d|2[0-3]):[0-5]\d$/.test(day[field])) throw new Error(`Enter a time for ${day.date}.`);
  }
}

// One-on-one days become 15-minute slots from `from` up to `to`; a group day is one slot with seats.
export function buildSlots(linkId, kind, days) {
  if (!Array.isArray(days) || !days.length) throw new Error('Add at least one day.');
  const slots = [];
  for (const day of days) {
    checkDay(day);
    if (kind === 'single') {
      if (!day.from || !day.to) throw new Error(`Enter a from and to time for ${day.date}.`);
      const from = toMinutes(day.from);
      const to = toMinutes(day.to);
      if (to - from < singleSlotMinutes) throw new Error(`On ${day.date} the to time has to be at least 15 minutes after the from time.`);
      for (let start = from; start + singleSlotMinutes <= to; start += singleSlotMinutes) {
        const time = toTime(start);
        slots.push({ id: `${linkId}-${day.date}-${time.replace(':', '')}`, start: pacificIso(day.date, time), minutes: singleSlotMinutes, seats: 1 });
      }
    } else {
      if (!day.time) throw new Error(`Enter a start time for ${day.date}.`);
      const seats = Number(day.seats);
      const minutes = Number(day.minutes);
      if (!Number.isInteger(seats) || seats < 2 || seats > 60) throw new Error(`Seats on ${day.date} have to be 2 to 60.`);
      if (!Number.isInteger(minutes) || minutes < 30 || minutes > 240) throw new Error(`Length on ${day.date} has to be 30 minutes to 4 hours.`);
      slots.push({ id: `${linkId}-${day.date}-${day.time.replace(':', '')}`, start: pacificIso(day.date, day.time), minutes, seats });
    }
  }
  return slots;
}

function mergeSlots(existing, added) {
  const ids = new Set(existing.map((slot) => slot.id));
  return [...existing, ...added.filter((slot) => !ids.has(slot.id))].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function createLink({ store, kind, days }, storeKeys, now = new Date()) {
  if (!storeKeys.includes(store)) throw new Error('Pick a store.');
  if (!interviewKinds.includes(kind)) throw new Error('Pick one-on-one or group.');
  const id = randomBytes(4).toString('hex').slice(0, 6);
  return { id, store, kind, createdAt: now.toISOString(), slots: mergeSlots([], buildSlots(id, kind, days)) };
}

export function addDays(link, days) {
  return { ...link, slots: mergeSlots(link.slots, buildSlots(link.id, link.kind, days)) };
}

export function removeSlot(link, slotId, bookings) {
  if (bookings.some((booking) => booking.slotId === slotId && !booking.cancelledAt)) {
    throw new Error('Someone is booked on that time. It can only be removed once their booking is cancelled.');
  }
  return { ...link, slots: link.slots.filter((slot) => slot.id !== slotId) };
}
