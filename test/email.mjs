// Checks the email text and calendar file without sending anything.
import assert from 'node:assert/strict';
import { bookingEmail } from '../netlify/lib/email.mjs';
import { mergeSettings, DEFAULTS } from '../netlify/lib/settings.mjs';

const single = { token: 'tok1', link: 'abc123', start: '2026-11-03T14:00:00-08:00', minutes: 15, seats: 1, store: 'downtown', firstName: 'Sofia' };

// Default texts.
const booked = bookingEmail('booked', single, 'https://example.netlify.app');
assert.equal(booked.subject, 'Interview booked: Tuesday, November 3 at 2:00pm');
assert.equal(booked.text, [
  'Hi Sofia,', '', 'Your interview is booked.', '',
  'When: Tuesday, November 3, 2026, 2:00pm (Pacific Time)', 'Where: Downtown, 100 Main St, Springfield', '',
  'Please bring your resume.', '', 'Change or cancel: https://example.netlify.app/?t=tok1', '', 'Demo Company'
].join('\n'));
assert.match(booked.html, /<a href="https:\/\/example\.netlify\.app\/\?t=tok1"[^>]*>Change or cancel<\/a>/);
assert.match(booked.ics, /DTSTART:20261103T220000Z\r\nDTEND:20261103T230000Z/, 'PST is UTC-8, one-hour entry');
assert.match(booked.ics, /SUMMARY:Interview at Demo Company Downtown/);
assert.match(booked.ics, /LOCATION:100 Main St\\, Springfield/);

// A group time reads exactly like a one-on-one time: no "group", no length, the same calendar entry.
const sat = { ...single, start: '2026-10-31T10:00:00-07:00' };
const group = bookingEmail('moved', { ...sat, minutes: 120, seats: 15 }, 'https://x');
const solo = bookingEmail('moved', { ...sat, minutes: 15, seats: 1 }, 'https://x');
assert.equal(group.subject, 'Interview moved: Saturday, October 31 at 10:00am');
assert.equal(group.text, solo.text);
assert.equal(group.html, solo.html);
assert.doesNotMatch(group.text, /group|hour/i);
assert.match(group.ics, /DTSTART:20261031T170000Z\r\nDTEND:20261031T180000Z/);

const cancelled = bookingEmail('cancelled', single, 'https://x');
assert.equal(cancelled.subject, 'Interview cancelled: Tuesday, November 3');
assert.equal(cancelled.ics, undefined);
assert.match(cancelled.text, /Your interview on Tuesday, November 3, 2026, 2:00pm \(Pacific Time\) is cancelled\./);
assert.match(cancelled.html, /<a href="https:\/\/x\/i\/abc123"[^>]*>Pick a new time<\/a>/);

// Saved settings: own texts with placeholders, a store note, a blank field falls back, a typo stays visible.
const custom = mergeSettings({
  stores: { ...DEFAULTS.stores, riverside: { name: 'Riverside', address: '2400 River Rd, Springfield', note: 'Use the side door.' } },
  rules: { calendarMinutes: '30' },
  email: { bookedSubject: 'See you {day}, {firstName}!', bookedLead: '  ', note: 'Bring your resume to {store}.', signature: 'Team {stor}' }
});
const mine = bookingEmail('booked', { ...single, store: 'riverside' }, 'https://x', custom);
assert.equal(mine.subject, 'See you Tuesday, November 3, Sofia!');
assert.match(mine.text, /\nYour interview is booked\.\n/, 'blank lead uses the default');
assert.match(mine.text, /\nBring your resume to Riverside\.\n\nUse the side door\.\n/);
assert.match(mine.text, /\nTeam \{stor\}$/, 'unknown placeholder is left as typed');
assert.match(mine.ics, /DTEND:20261103T223000Z/, 'calendar length from the rules');

// Applicant input is escaped in the HTML.
const sneaky = bookingEmail('booked', { ...single, firstName: '<b>x</b>' }, 'https://x');
assert.match(sneaky.html, /Hi &lt;b&gt;x&lt;\/b&gt;,/);

// Settings that make no sense fall back instead of breaking.
const odd = mergeSettings({ rules: { cutoffHours: 'abc', maxDaysAhead: '', calendarMinutes: 2.5 }, stores: {} });
assert.deepEqual(odd.rules, DEFAULTS.rules);
assert.deepEqual(Object.keys(odd.stores), ['downtown', 'riverside', 'hillcrest'], 'an empty store list keeps the defaults');

console.log('ok: default texts, placeholders, store note, blank fields, group = one-on-one, calendar length, escaping');
