// calendar.js — Export upcoming plant care as an .ics calendar file.
//
// This is the zero-install reminder path for ordinary users: instead of
// building the native app, they tap "Add to calendar" and their own calendar
// (Google/Apple/Outlook) delivers the reminders — reliably, cross-platform, and
// with no server or account on our side.
//
// Design goals the user asked for — don't muddy other events, don't overflow:
//   • ONE event per day, grouping every plant due that day (not one per plant).
//   • Events sit on real due dates across a bounded horizon, so a weekly plant
//     makes ~8 events over 2 months, not 60.
//   • TRANSP:TRANSPARENT → marked "free", so they never block availability.
//   • CATEGORIES:Plant care + a distinct title → easy to spot and bulk-delete.
//   • Stable per-day UID → re-exporting UPDATES the same day instead of
//     duplicating, so refreshing after changes doesn't pile up copies.

import {
  waterStatus, feedStatus, photoStatus,
  effectiveWaterInterval, effectiveFeedInterval,
  startOfDay, addDays, PHOTO_INTERVAL_DAYS,
} from './schedule.js';
import { seasonForDate, shouldFeed } from './season.js';

const HORIZON_DAYS = 60; // how far ahead to schedule — bounds calendar clutter
const REMIND_HOUR = 9;   // 09:00 local (floating time — 9am wherever the user is)
const REMIND_END_MIN = 15;
const MAX_EVENTS = 120;  // hard safety cap against overflow

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// Floating local timestamp (no Z / no TZID) so 09:00 means 9am in the viewer's
// own zone, and survives DST without timezone tables.
function floatingAt(d, hour, min = 0) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(hour)}${pad(min)}00`;
}
// UTC stamp for DTSTAMP (required to be absolute).
function utcStamp(d) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}
// Escape per RFC 5545 text rules.
function esc(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}
// Fold long content lines to ≤75 octets with a leading-space continuation.
function fold(line) {
  const enc = new TextEncoder();
  let out = '';
  let cur = '';
  for (const ch of line) {
    if (enc.encode(cur + ch).length > 73) { out += (out ? '\r\n ' : '') + cur; cur = ch; }
    else cur += ch;
  }
  return out + (out ? '\r\n ' : '') + cur;
}

// Project each care task forward over the horizon assuming on-time care, so the
// calendar carries a recurring series (weekly watering, etc.), not just the next
// single due date. Overdue tasks anchor their first reminder to today.
function projectOccurrences(plant, events, now, horizonEnd, hemisphere) {
  const today = startOfDay(now);
  const profile = plant.profile;
  const occ = [];
  const clampStart = (due) => { const d = startOfDay(due); return d < today ? new Date(today) : d; };

  // Watering — interval shifts with season, so recompute at each step.
  {
    let d = clampStart(waterStatus(plant, events, now, hemisphere).due);
    let g = 0;
    while (d <= horizonEnd && g++ < 400) {
      occ.push({ date: new Date(d), type: 'water' });
      d = startOfDay(addDays(d, Math.max(1, effectiveWaterInterval(profile, d, hemisphere, plant.conditions))));
    }
  }
  // Feeding — only when this plant is fed, and skip dates where feeding pauses
  // seasonally (no "fertilize in winter" reminders).
  if (profile.fertilize) {
    const f = feedStatus(plant, events, now, hemisphere);
    if (f) {
      const interval = Math.max(1, effectiveFeedInterval(plant));
      let d = clampStart(f.due);
      let g = 0;
      while (d <= horizonEnd && g++ < 400) {
        if (shouldFeed(seasonForDate(d, hemisphere), profile.feedWinter)) occ.push({ date: new Date(d), type: 'fertilize' });
        d = startOfDay(addDays(d, interval));
      }
    }
  }
  // Progress photos — fixed 30-day cadence from the last photo.
  {
    const ps = photoStatus(plant, events, now);
    let d = clampStart(addDays(ps.baseline, PHOTO_INTERVAL_DAYS));
    let g = 0;
    while (d <= horizonEnd && g++ < 400) {
      occ.push({ date: new Date(d), type: 'photo' });
      d = startOfDay(addDays(d, PHOTO_INTERVAL_DAYS));
    }
  }
  return occ;
}

// Build the full .ics text. Returns { ics, eventCount } or null if nothing due.
// formatReminder is passed in (defined in app.js) so titles/bodies match the
// app's own localized reminder copy.
export function buildPlantCareICS({ plants, events, settings, formatReminder, now = new Date() }) {
  const hemisphere = settings.hemisphere;
  const horizonEnd = addDays(startOfDay(now), HORIZON_DAYS);

  // Group every occurrence by calendar day.
  const byDay = new Map();
  for (const p of plants) {
    for (const o of projectOccurrences(p, events, now, horizonEnd, hemisphere)) {
      const key = dayKey(o.date);
      if (!byDay.has(key)) byDay.set(key, { date: o.date, tasks: [] });
      byDay.get(key).tasks.push({ plantId: p.id, name: p.name, type: o.type, due: o.date.toISOString() });
    }
  }
  if (!byDay.size) return null;

  const days = [...byDay.values()].sort((a, b) => a.date - b.date).slice(0, MAX_EVENTS);
  const stamp = utcStamp(now);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Plant Tracker//Plant care reminders//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Plant care',
  ];
  for (const { date, tasks } of days) {
    const msg = formatReminder(tasks, date) || { title: '🌿 Plant care', body: '' };
    lines.push(
      'BEGIN:VEVENT',
      `UID:plantcare-${dayKey(date)}@planttracker.app`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${floatingAt(date, REMIND_HOUR)}`,
      `DTEND:${floatingAt(date, REMIND_HOUR, REMIND_END_MIN)}`,
      `SUMMARY:${esc(msg.title)}`,
      ...(msg.body ? [`DESCRIPTION:${esc(msg.body)}`] : []),
      'CATEGORIES:Plant care',
      'TRANSP:TRANSPARENT',
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${esc(msg.title)}`,
      'TRIGGER:PT0M',
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');

  return { ics: lines.map(fold).join('\r\n'), eventCount: days.length };
}
