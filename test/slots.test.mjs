import assert from 'node:assert/strict';
import test from 'node:test';
import { pacificIso, buildSlots, createLink, addDays, removeSlot } from '../netlify/lib/slots.mjs';

test('Pacific times pick PDT or PST for the date', () => {
  assert.equal(pacificIso('2026-10-27', '14:00'), '2026-10-27T14:00:00-07:00');
  assert.equal(pacificIso('2026-11-03', '14:00'), '2026-11-03T14:00:00-08:00'); // after the Nov 1 switch
  assert.throws(() => pacificIso('2027-03-14', '02:30'), /doesn't exist/); // skipped hour
});

test('one-on-one range becomes 15-minute slots, end time exclusive', () => {
  const slots = buildSlots('abc', 'single', [{ date: '2026-10-27', from: '14:00', to: '15:00' }]);
  assert.deepEqual(slots.map((s) => s.start.slice(11, 16)), ['14:00', '14:15', '14:30', '14:45']);
  assert.deepEqual(slots[0], { id: 'abc-2026-10-27-1400', start: '2026-10-27T14:00:00-07:00', minutes: 15, seats: 1 });
  assert.throws(() => buildSlots('abc', 'single', [{ date: '2026-10-27', from: '15:00', to: '15:10' }]), /at least 15 minutes/);
  assert.throws(() => buildSlots('abc', 'single', []), /at least one day/);
});

test('group day is one slot with seats and length', () => {
  const [slot] = buildSlots('abc', 'group', [{ date: '2026-10-31', time: '10:00', seats: '15', minutes: '120' }]);
  assert.deepEqual(slot, { id: 'abc-2026-10-31-1000', start: '2026-10-31T10:00:00-07:00', minutes: 120, seats: 15 });
  assert.throws(() => buildSlots('abc', 'group', [{ date: '2026-10-31', time: '10:00', seats: 1, minutes: 120 }]), /Seats/);
});

test('links: create, add days without duplicates, remove only unbooked times', () => {
  const stores = ['downtown', 'riverside', 'hillcrest'];
  const link = createLink({ store: 'downtown', kind: 'single', days: [{ date: '2026-10-29', from: '15:00', to: '15:30' }] }, stores, new Date('2026-10-23T12:00:00Z'));
  assert.match(link.id, /^[0-9a-f]{6}$/);
  assert.equal(link.slots.length, 2);
  assert.throws(() => createLink({ store: 'nope', kind: 'single', days: [] }, stores), /store/);

  const more = addDays(link, [{ date: '2026-10-27', from: '15:00', to: '15:30' }, { date: '2026-10-29', from: '15:00', to: '15:30' }]);
  assert.equal(more.slots.length, 4, 'same day twice adds nothing');
  assert.equal(more.slots[0].start.slice(0, 10), '2026-10-27', 'sorted by time');

  const booked = [{ slotId: more.slots[0].id, cancelledAt: null }, { slotId: more.slots[1].id, cancelledAt: '2026-10-24T00:00:00Z' }];
  assert.throws(() => removeSlot(more, more.slots[0].id, booked), /booked/);
  assert.equal(removeSlot(more, more.slots[1].id, booked).slots.length, 3, "a cancelled booking doesn't block");
});
