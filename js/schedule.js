// schedule.js — Turns care logs + seasonal rules into due dates and status.

import { wateringMultiplier, shouldFeed, seasonForDate } from './season.js';
import { getSpecies } from './species.js';

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

// How heavily a plant feeds, by category — multiplies its base feeding interval.
// Flowering plants and herbs are hungry (feed more often → shorter interval);
// succulents & cacti are light feeders (feed less often → longer interval).
export function feedCategoryFactor(category) {
  return { flowering: 0.6, herb: 0.55, succulent: 1.35 }[category] ?? 1.0;
}

// The plant's category — from its library species if it has one, otherwise from
// the category stored on its own profile (set via the form's "Plant type" picker
// or an AI/paste lookup), falling back to 'other'.
export function plantCategory(plant) {
  const s = plant.speciesId ? getSpecies(plant.speciesId) : null;
  return (s && s.category) || (plant.profile && plant.profile.category) || 'other';
}

// The feeding interval adjusted for the plant type (days).
export function effectiveFeedInterval(plant) {
  const base = plant.profile.fertilize;
  if (!base) return base; // 0 = rarely fed
  return Math.max(1, Math.round(base * feedCategoryFactor(plantCategory(plant))));
}

export function startOfDay(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

export function daysBetween(a, b) {
  return Math.round((startOfDay(b) - startOfDay(a)) / MS_PER_DAY);
}

export function addDays(date, n) {
  const x = new Date(date);
  x.setDate(x.getDate() + Math.round(n));
  return x;
}

// How this plant's actual pot & spot shift its watering frequency. Terracotta
// and small pots dry out faster (water more often → shorter interval); large or
// no-drainage pots and low light hold moisture longer. Unset factors = neutral.
export function conditionMultiplier(c) {
  if (!c) return 1;
  const size = { small: 0.82, medium: 1, large: 1.25 }[c.potSize];
  const material = { terracotta: 0.82, plastic: 1.1, ceramic: 1.1, metal: 1.12 }[c.potMaterial];
  const drainage = { yes: 1, no: 1.3 }[c.drainage];
  const light = { low: 1.25, medium: 1, bright: 0.85 }[c.lightSpot];
  let m = 1;
  for (const f of [size, material, drainage, light]) if (f) m *= f;
  return Math.min(1.8, Math.max(0.55, m)); // clamp so factors can't compound absurdly
}

// The effective watering interval (days): base × season × pot/spot conditions.
export function effectiveWaterInterval(profile, date, hemisphere, conditions) {
  const season = seasonForDate(date, hemisphere);
  const mult = wateringMultiplier(season, profile.winterFactor);
  return Math.max(1, Math.round(profile.water * mult * conditionMultiplier(conditions)));
}

// The most recent event of a given type for a plant.
export function lastEvent(events, plantId, type) {
  let best = null;
  for (const e of events) {
    if (e.plantId !== plantId || e.type !== type) continue;
    if (!best || new Date(e.date) > new Date(best.date)) best = e;
  }
  return best;
}

// Compute watering status for a plant relative to `now`.
export function waterStatus(plant, events, now, hemisphere) {
  const profile = plant.profile;
  const interval = effectiveWaterInterval(profile, now, hemisphere, plant.conditions);
  const last = lastEvent(events, plant.id, 'water');
  const lastDate = last ? new Date(last.date) : (plant.acquiredDate ? new Date(plant.acquiredDate) : new Date(plant.createdAt));
  const due = addDays(lastDate, interval);
  const daysUntil = daysBetween(now, due);
  return {
    type: 'water',
    interval,
    lastDate,
    due,
    daysUntil, // negative = overdue
    everDone: !!last,
    state: statusState(daysUntil),
  };
}

// Compute fertilizing status. Feeding pauses seasonally.
//
// Feed rides along with watering: liquid fertilizer is mixed into the watering
// can, so a feed due between waterings must NOT claim its own day — that would
// push people to water early (overwatering) or feed onto dry roots. Instead the
// elapsed interval "arms" the feed, and its due date snaps to the watering it
// will ride on. Late is harmless (the interval is a minimum spacing); early is
// what burns roots — so we only ever round toward the next watering.
export function feedStatus(plant, events, now, hemisphere) {
  const profile = plant.profile;
  if (!profile.fertilize) return null; // this plant isn't fed on a schedule
  const interval = effectiveFeedInterval(plant);
  const season = seasonForDate(now, hemisphere);
  const active = shouldFeed(season, profile.feedWinter);
  const last = lastEvent(events, plant.id, 'fertilize');
  const lastDate = last ? new Date(last.date) : (plant.acquiredDate ? new Date(plant.acquiredDate) : new Date(plant.createdAt));
  const rawDue = addDays(lastDate, interval);       // when the interval elapses
  const rawDaysUntil = daysBetween(now, rawDue);
  // The watering this feed will ride on: the next water due at/after rawDue.
  // (We only know the next watering; a feed arming later than that keeps its
  // raw date as the best estimate until the schedule catches up.)
  const water = waterStatus(plant, events, now, hemisphere);
  const withWater = water.due >= rawDue;
  const due = withWater ? water.due : rawDue;
  const daysUntil = daysBetween(now, due);
  return {
    type: 'fertilize',
    interval,
    lastDate,
    due,
    daysUntil,
    rawDue,
    rawDaysUntil,
    armed: active && rawDaysUntil <= 0, // interval elapsed — feed at the next watering
    withWater,                          // due date coincides with a watering
    everDone: !!last,
    paused: !active,
    state: active ? statusState(daysUntil) : 'paused',
  };
}

function statusState(daysUntil) {
  if (daysUntil < 0) return 'overdue';
  if (daysUntil === 0) return 'due';
  if (daysUntil <= 2) return 'soon';
  return 'ok';
}

// Overall health signal for a plant card: worst of its active tasks, plus any
// recent health note. Returns { level, label }.
export function overallStatus(plant, events, now, hemisphere) {
  const w = waterStatus(plant, events, now, hemisphere);
  const f = feedStatus(plant, events, now, hemisphere);
  const states = [w.state, f && f.state !== 'paused' ? f.state : null].filter(Boolean);

  // Factor in the latest self-reported health note.
  const health = lastEvent(events, plant.id, 'health');
  const healthLevel = health ? health.health : null; // 'good' | 'ok' | 'poor'

  let level = 'good';
  if (states.includes('overdue') || healthLevel === 'poor') level = 'poor';
  else if (states.includes('due') || states.includes('soon') || healthLevel === 'ok') level = 'watch';

  const label = { good: 'Healthy', watch: 'Needs attention', poor: 'At risk' }[level];
  return { level, label, water: w, feed: f, healthNote: health };
}

// ---- Progress photos ----------------------------------------------------

export const PHOTO_INTERVAL_DAYS = 30;

export function lastPhotoDate(plant, events) {
  let best = null;
  for (const e of events) {
    if (e.plantId !== plant.id || !e.photo) continue;
    const d = new Date(e.date);
    if (!best || d > best) best = d;
  }
  return best;
}

// Whether it's time for a fresh progress photo (none in `intervalDays`).
export function photoStatus(plant, events, now, intervalDays = PHOTO_INTERVAL_DAYS) {
  const last = lastPhotoDate(plant, events);
  const baseline = last || (plant.acquiredDate ? new Date(plant.acquiredDate) : new Date(plant.createdAt));
  const daysSince = daysBetween(baseline, now);
  return { last, baseline, daysSince, due: daysSince >= intervalDays };
}

// All tasks due on/before `now` (+ optional look-ahead window), across plants.
export function dueTasks(plants, events, now, hemisphere, lookAheadDays = 0) {
  const tasks = [];
  for (const p of plants) {
    const w = waterStatus(p, events, now, hemisphere);
    if (w.daysUntil <= lookAheadDays) tasks.push({ plant: p, ...w });
    const f = feedStatus(p, events, now, hemisphere);
    if (f && f.state !== 'paused' && f.daysUntil <= lookAheadDays) tasks.push({ plant: p, ...f });
  }
  // Most overdue first.
  tasks.sort((a, b) => a.daysUntil - b.daysUntil);
  return tasks;
}
