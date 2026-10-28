// Everything that can change without a deploy lives in the `settings` blob; the booking page and
// the emails read it on every request. These defaults fill any section or field that is missing
// or blank, so a half-filled or missing blob can never produce an empty email.
export const DEFAULTS = {
  stores: {
    downtown: { name: 'Downtown', address: '100 Main St, Springfield', note: '' },
    riverside: { name: 'Riverside', address: '2400 River Rd, Springfield', note: '' },
    hillcrest: { name: 'Hillcrest', address: '815 Hill Ave, Springfield', note: '' }
  },
  rules: {
    cutoffHours: 2, // booking closes this many hours before the time
    maxDaysAhead: 0, // 0 = show every time on the link
    calendarMinutes: 60, // length of the calendar entry in the email
    maxBookingsPerHour: 5, // bookings and moves per device (IP) per hour, against spam and slot-filling
    retentionDays: 90 // bookings are deleted this many days after the interview
  },
  page: {
    host: 'Demo Company',
    title: 'Job Interview',
    duration: '15 min',
    bookedNote: 'Please bring your resume.',
    noLink: 'Use the link from your message to book an interview.',
    footer: 'Demo Company'
  },
  email: {
    senderName: 'Demo Company',
    greeting: 'Hi {firstName},',
    note: 'Please bring your resume.',
    signature: 'Demo Company',
    calendarTitle: 'Interview at Demo Company {store}',
    bookedSubject: 'Interview booked: {day} at {time}',
    bookedLead: 'Your interview is booked.',
    bookedButton: 'Change or cancel',
    movedSubject: 'Interview moved: {day} at {time}',
    movedLead: 'Your interview has a new time.',
    movedButton: 'Change or cancel',
    cancelledSubject: 'Interview cancelled: {day}',
    cancelledLead: 'Your interview on {when} is cancelled.',
    cancelledButton: 'Pick a new time'
  }
};

export const PLACEHOLDERS = ['firstName', 'day', 'time', 'when', 'where', 'store'];

const text = (value, fallback) => String(value ?? '').trim() || fallback;
const whole = (value, fallback) => (Number.isInteger(Number(value)) && String(value ?? '').trim() !== '' ? Number(value) : fallback);
const section = (defaults, saved = {}) =>
  Object.fromEntries(Object.entries(defaults).map(([key, fallback]) =>
    [key, typeof fallback === 'number' ? whole(saved?.[key], fallback) : text(saved?.[key], fallback)]));

// The saved blob (or nothing) -> complete settings. Stores are replaced as a whole list, so removed stores stay removed.
export function mergeSettings(saved = {}) {
  const stores = saved?.stores && Object.keys(saved.stores).length ? saved.stores : DEFAULTS.stores;
  return {
    stores: Object.fromEntries(Object.entries(stores).map(([key, s]) => [key, { name: text(s?.name, key), address: text(s?.address, ''), note: String(s?.note ?? '').trim() }])),
    rules: section(DEFAULTS.rules, saved?.rules),
    page: section(DEFAULTS.page, saved?.page),
    email: section(DEFAULTS.email, saved?.email)
  };
}

// "{day} at {time}" -> "Tuesday, October 27 at 2:00pm". Unknown placeholders stay as typed, so a typo shows up in the email.
export const fill = (template, vars) => template.replace(/\{(\w+)\}/g, (match, key) => (key in vars ? vars[key] : match));
