// native.js — Native (Capacitor/Android) local notification scheduling.
//
// Why this exists: on the web, the app can only *poll* for due plants when
// something wakes it (an open, or Chrome's best-effort periodic sync). Inside
// the native app we can do better: because plant care is deterministic, we
// pre-compute the upcoming schedule and hand the OS a list of dated
// notifications. Android then fires them at the right time even when the app is
// fully closed — no server, no push, no FCM.
//
// The whole module is a no-op on the web (isNative === false), so app.js can
// call into it unconditionally and the PWA path is untouched.

import { dueTasks, photoStatus, startOfDay, addDays } from './schedule.js';

const Cap = typeof window !== 'undefined' ? window.Capacitor : undefined;

// True only inside the packaged native app. On the web this is false and every
// exported function below returns harmlessly.
export const isNative = !!(Cap && typeof Cap.isNativePlatform === 'function' && Cap.isNativePlatform());

// Plugins are reached through Capacitor's bridge (no bundler needed): the native
// layer registers them under window.Capacitor.Plugins.*
function LN() { return Cap && Cap.Plugins ? Cap.Plugins.LocalNotifications : null; }
function AppPlugin() { return Cap && Cap.Plugins ? Cap.Plugins.App : null; }

// Reminders fire at 09:00 local time; we schedule one summary per day across
// this horizon and re-arm on every app open/resume so it stays fresh.
const REMIND_HOUR = 9;
const HORIZON_DAYS = 30;
const CHANNEL_ID = 'plant-care';
// A fixed id block so re-arming can reliably cancel the previous batch.
const ID_BASE = 2000;

// Ask for (or confirm) the OS notification permission. Android 13+ requires a
// runtime grant; older versions auto-grant. Returns true if we may post.
export async function requestNativePermission() {
  const ln = LN();
  if (!ln) return false;
  try {
    let status = await ln.checkPermissions();
    if (status.display !== 'granted') status = await ln.requestPermissions();
    return status.display === 'granted';
  } catch {
    return false;
  }
}

// Reports whether native reminders can fire, for the Settings status line.
export async function nativeNotificationStatus() {
  const ln = LN();
  if (!ln) return { code: 'unsupported' };
  try {
    const status = await ln.checkPermissions();
    if (status.display === 'granted') return { code: 'active' };
    if (status.display === 'denied') return { code: 'blocked' };
    return { code: 'inactive' };
  } catch {
    return { code: 'unsupported' };
  }
}

async function ensureChannel(ln) {
  if (!ln.createChannel) return;
  try {
    await ln.createChannel({
      id: CHANNEL_ID,
      name: 'Plant care reminders',
      description: 'Watering, feeding and progress-photo reminders',
      importance: 4, // high — shows a heads-up banner
      visibility: 1,
    });
  } catch { /* channels are Android-only; ignore elsewhere */ }
}

// Build one summary notification per day over the horizon, based on the current
// care state (assuming no further care) — so an overdue plant keeps nudging each
// day until it's watered, at which point the next re-arm clears and rebuilds it.
function buildDailyDigests(plants, events, settings, formatReminder, now) {
  const out = [];
  const hemisphere = settings.hemisphere;
  for (let i = 0; i < HORIZON_DAYS; i++) {
    const day = startOfDay(addDays(now, i));
    const at = new Date(day);
    at.setHours(REMIND_HOUR, 0, 0, 0);
    if (at.getTime() <= now.getTime()) continue; // can't schedule in the past

    const care = dueTasks(plants, events, day, hemisphere, 0)
      .map((t) => ({ plantId: t.plant.id, name: t.plant.name, type: t.type, due: t.due.toISOString() }));
    const photo = plants
      .filter((p) => photoStatus(p, events, day).due)
      .map((p) => ({ plantId: p.id, name: p.name, type: 'photo', due: day.toISOString() }));
    const all = care.concat(photo);
    if (!all.length) continue;

    const msg = formatReminder(all, day);
    if (!msg) continue;
    out.push({ id: ID_BASE + i, at, title: msg.title, body: msg.body });
  }
  return out;
}

async function cancelOurs(ln) {
  try {
    const pending = await ln.getPending();
    const ours = (pending.notifications || [])
      .filter((n) => n.id >= ID_BASE && n.id < ID_BASE + HORIZON_DAYS)
      .map((n) => ({ id: n.id }));
    if (ours.length) await ln.cancel({ notifications: ours });
  } catch { /* nothing pending / not supported */ }
}

// Cancel the old batch and schedule a fresh one from current data. Call on app
// open, on resume, and after any care action that changes the schedule.
export async function rearmReminders({ plants, events, settings, formatReminder, now = new Date() }) {
  const ln = LN();
  if (!ln) return { scheduled: 0 };

  // Reminders off, or permission not granted → make sure nothing lingers.
  if (!settings.notifications) { await cancelOurs(ln); return { scheduled: 0 }; }
  const granted = await requestNativePermission();
  if (!granted) { await cancelOurs(ln); return { scheduled: 0, denied: true }; }

  await ensureChannel(ln);
  await cancelOurs(ln);

  const digests = buildDailyDigests(plants, events, settings, formatReminder, now);
  if (!digests.length) return { scheduled: 0 };

  const notifications = digests.map((d) => ({
    id: d.id,
    title: d.title,
    body: d.body,
    schedule: { at: d.at.toISOString(), allowWhileIdle: true },
    channelId: CHANNEL_ID,
    smallIcon: 'ic_stat_plant',
    autoCancel: true,
  }));
  try {
    await ln.schedule({ notifications });
    return { scheduled: notifications.length, first: digests[0].at };
  } catch {
    return { scheduled: 0, error: true };
  }
}

// Fire a one-off notification a few seconds out to prove the on-device path
// works end to end (permission → channel → OS delivery), independent of whether
// anything is actually due. Returns true if it was scheduled.
export async function sendTestNotification({ lang = 'en' } = {}) {
  const ln = LN();
  if (!ln) return false;
  const granted = await requestNativePermission();
  if (!granted) return false;
  await ensureChannel(ln);
  const nl = lang === 'nl';
  const at = new Date(Date.now() + 3000);
  try {
    await ln.schedule({
      notifications: [{
        id: ID_BASE - 1, // outside the daily-reminder id block
        title: nl ? '🌿 Testmelding' : '🌿 Test reminder',
        body: nl ? 'Zo zien je plantenzorg-herinneringen eruit.' : 'This is what your plant-care reminders will look like.',
        schedule: { at: at.toISOString(), allowWhileIdle: true },
        channelId: CHANNEL_ID,
        smallIcon: 'ic_stat_plant',
        autoCancel: true,
      }],
    });
    return true;
  } catch {
    return false;
  }
}

// Write the generated .ics to a temp file and open it, so the OS hands it to the
// calendar app (which shows the events and lets the user confirm). This avoids
// the "downloaded file vanished somewhere" problem of a plain web download inside
// the WebView. Returns true if handed off, false if unavailable (caller falls
// back to a normal download).
export async function openCalendarFile(icsText, filename = 'plant-care.ics') {
  const fs = Cap && Cap.Plugins ? Cap.Plugins.Filesystem : null;
  const opener = Cap && Cap.Plugins ? Cap.Plugins.FileOpener : null;
  if (!fs || !opener) return false;
  try {
    const written = await fs.writeFile({
      path: filename,
      data: icsText,
      directory: 'CACHE',   // app-private cache — no storage permission needed
      encoding: 'utf8',
    });
    // openWithDefault:true launches the calendar app directly (ACTION_VIEW for
    // text/calendar) instead of showing a generic "Open with" chooser.
    await opener.open({ filePath: written.uri, contentType: 'text/calendar', openWithDefault: true });
    return true;
  } catch {
    return false;
  }
}

// Open the device camera via the native Camera plugin and return a resized JPEG
// data URL (or null if cancelled/unavailable). Native only — on web the app uses
// an <input capture> instead. This exists because inside the WebView that file
// input opens the gallery rather than the camera, so we go straight to the
// plugin, which launches the real camera. Our manifest doesn't declare CAMERA,
// so the plugin uses the system camera intent with no runtime permission prompt.
export async function takePhoto() {
  const cam = Cap && Cap.Plugins ? Cap.Plugins.Camera : null;
  if (!cam) return null;
  try {
    const photo = await cam.getPhoto({
      source: 'CAMERA',
      resultType: 'dataUrl',
      quality: 82,
      width: 1600,
      correctOrientation: true,
      saveToGallery: false,
    });
    return photo && photo.dataUrl ? photo.dataUrl : null;
  } catch {
    return null; // user cancelled, or no camera available
  }
}

// Wire up resume + tap handling once, at boot. onResume lets app.js re-arm when
// the user returns; onOpen focuses/deep-links when a notification is tapped.
export async function initNative({ onResume, onOpen } = {}) {
  const app = AppPlugin();
  const ln = LN();
  if (app && onResume) {
    try {
      app.addListener('resume', () => { onResume(); });
      app.addListener('appStateChange', (state) => { if (state && state.isActive) onResume(); });
    } catch { /* ignore */ }
  }
  if (ln) {
    try {
      ln.addListener('localNotificationActionPerformed', (action) => {
        const extra = action && action.notification && action.notification.extra;
        if (onOpen) onOpen(extra && extra.url);
      });
    } catch { /* ignore */ }
  }
}
