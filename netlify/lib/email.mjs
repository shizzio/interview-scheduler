import nodemailer from 'nodemailer';
import { mergeSettings, fill } from './settings.mjs';

// Sent from a Gmail account with an app password (GMAIL_USER / GMAIL_APP_PASSWORD env vars, never
// in code). Without them nothing is sent and bookings still work. The words come from the settings
// blob; only the layout lives here.
const TZ = 'America/Los_Angeles';
const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const time = (ms) => timeFmt.format(new Date(ms)).replace(' ', '').toLowerCase();

// Group and one-on-one emails read the same: applicants aren't told about the group or its length.
export function placeholderValues(b, store) {
  const start = Date.parse(b.start);
  return {
    firstName: b.firstName,
    day: dayFmt.format(start).replace(/, \d{4}$/, ''),
    time: time(start),
    when: `${dayFmt.format(start)}, ${time(start)} (Pacific Time)`,
    where: `${store.name}, ${store.address}`,
    store: store.name
  };
}

const icsText = (s) => s.replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
const icsTime = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function calendarFile(b, { title, address, minutes, manageUrl, sender }) {
  const start = Date.parse(b.start);
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${icsText(sender)}//Interviews//EN`, 'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${b.token}@interview-scheduler`,
    `DTSTAMP:${icsTime(Date.now())}`,
    `DTSTART:${icsTime(start)}`,
    `DTEND:${icsTime(start + minutes * 60000)}`,
    `SUMMARY:${icsText(title)}`,
    `LOCATION:${icsText(address)}`,
    `DESCRIPTION:${icsText(`Change or cancel: ${manageUrl}`)}`,
    'END:VEVENT', 'END:VCALENDAR', ''
  ].join('\r\n');
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Table layout and inline styles, because Gmail and Outlook drop <style> blocks and flexbox.
function emailHtml({ greeting, lead, rows = [], notes = [], button, preheader, signature }) {
  const row = ([label, value]) => `<tr><td style="padding:4px 12px 4px 0;color:#5c5f63;font-weight:600;vertical-align:top;white-space:nowrap;">${esc(label)}</td><td style="padding:4px 0;color:#1a1a1a;">${esc(value)}</td></tr>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"></head>
<body style="margin:0;padding:0;background:#f6f6f6;">
<div style="display:none;max-height:0;overflow:hidden;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f6;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e3e3e3;border-radius:8px;font-family:${FONT};font-size:16px;line-height:1.5;color:#1a1a1a;">
<tr><td style="padding:28px 24px 8px;">
<p style="margin:0 0 16px;">${esc(greeting)}</p>
<p style="margin:0 0 16px;">${esc(lead)}</p>
${rows.length ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:16px;">${rows.map(row).join('')}</table>` : ''}
${notes.map((note) => `<p style="margin:0 0 16px;">${esc(note)}</p>`).join('\n')}
${button ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px 0 24px;"><tr><td style="border-radius:24px;background:#1d4ed8;">
<a href="${esc(button.url)}" style="display:inline-block;padding:13px 28px;border-radius:24px;color:#ffffff;font-family:${FONT};font-size:18px;font-weight:700;text-decoration:none;">${esc(button.label)}</a>
</td></tr></table>` : ''}
</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #e3e3e3;color:#5c5f63;font-size:14px;">${esc(signature)}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

// kind: 'booked' | 'moved' | 'cancelled'. b = the public booking (start, store key, firstName, token, link).
export function bookingEmail(kind, b, origin, settings = mergeSettings()) {
  const { email, rules } = settings;
  const store = settings.stores[b.store] || { name: b.storeName || b.store, address: b.address || '', note: '' };
  const vars = placeholderValues(b, store);
  const say = (template) => fill(template, vars);
  const greeting = say(email.greeting);
  const lead = say(email[`${kind}Lead`]);
  const signature = say(email.signature);
  const button = kind === 'cancelled'
    ? (b.link ? { label: say(email.cancelledButton), url: `${origin}/i/${b.link}` } : null)
    : { label: say(email[`${kind}Button`]), url: `${origin}/?t=${b.token}` };
  const rows = kind === 'cancelled' ? [] : [['When', vars.when], ['Where', vars.where]];
  const notes = kind === 'cancelled' ? [] : [say(email.note), say(store.note)].filter(Boolean);
  const text = [greeting, '', lead, '', ...rows.map(([label, value]) => `${label}: ${value}`), ...(rows.length ? [''] : []),
    ...notes.flatMap((note) => [note, '']), ...(button ? [`${button.label}: ${button.url}`, ''] : []), signature].join('\n');
  return {
    subject: say(email[`${kind}Subject`]),
    text,
    html: emailHtml({ greeting, lead, rows, notes, button, signature, preheader: rows.length ? `${vars.when}, ${vars.where}` : lead }),
    ics: kind === 'cancelled' ? undefined : calendarFile(b, {
      title: say(email.calendarTitle), address: store.address, minutes: rules.calendarMinutes, manageUrl: `${origin}/?t=${b.token}`, sender: email.senderName
    })
  };
}

let transport;

// Never throws: a booking must not fail because Gmail is slow or down. Returns whether it went out.
export async function sendBookingEmail(kind, to, b, origin, settings = mergeSettings()) {
  // example.com is reserved (RFC 2606), so it is only ever test data.
  if (/@example\.com$/i.test(to)) return false;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    console.error('Booking email skipped: GMAIL_USER / GMAIL_APP_PASSWORD not set');
    return false;
  }
  try {
    transport ||= nodemailer.createTransport({ service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
    const mail = bookingEmail(kind, b, origin, settings);
    await transport.sendMail({
      from: { name: settings.email.senderName, address: process.env.GMAIL_USER },
      to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: mail.ics ? [{ filename: 'interview.ics', content: mail.ics, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }] : []
    });
    return true;
  } catch (err) {
    console.error('Booking email failed:', err.message);
    return false;
  }
}
