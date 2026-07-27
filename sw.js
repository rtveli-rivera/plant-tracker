// sw.js — Service worker for offline support and installability.
//
// Strategy: cache-first for the app shell (it's fully static), so the app
// opens instantly and works with no network. Bump CACHE when files change.

const CACHE = 'plant-tracker-v61';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/species.js',
  './js/season.js',
  './js/schedule.js',
  './js/diagnostics.js',
  './js/settings.js',
  './js/util.js',
  './js/coach.js',
  './js/quips.js',
  './js/refphoto.js',
  './js/symptomart.js',
  './js/refmanifest.js',
  './js/ai.js',
  './js/handoff.js',
  './js/i18n.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// Bundled reference photos live in their own STABLE cache: unlike the app shell
// they never change between releases, so they're fetched once per device — not
// re-downloaded (~1.4 MB) on every version bump. The activate cleanup spares
// this cache, and install only fills in whatever is missing.
const IMG_CACHE = 'plant-tracker-img-v1';
const IMG_ASSETS = [
  'african-violet.jpg', 'aloe-vera.jpg', 'anthurium.jpg', 'begonia.jpg', 'cactus.jpg',
  'calathea.jpg', 'chinese-evergreen.jpg', 'dracaena.jpg', 'english-ivy.jpg',
  'fern-boston.png', 'fiddle-leaf-fig.jpg', 'herb-basil.jpg', 'herb-generic.jpg',
  'jade-plant.jpg', 'monstera.jpg', 'orchid-phalaenopsis.jpg', 'peace-lily.jpg',
  'philodendron.jpg', 'pothos.jpg', 'rubber-plant.jpg', 'snake-plant.jpg',
  'spider-plant.jpg', 'string-of-pearls.jpg', 'succulent-generic.jpg',
  'tropical-generic.jpg', 'zz-plant.jpg',
].map((f) => './img/species/' + f).concat([
  './img/symptoms/yellow-leaves.jpg', './img/symptoms/pests.jpg',
]);

async function fillImageCache() {
  const cache = await caches.open(IMG_CACHE);
  for (const url of IMG_ASSETS) {
    if (await cache.match(url)) continue; // already have it — never refetch
    try {
      const res = await fetch(url);
      if (res.ok) await cache.put(url, res);
    } catch { /* offline install — the fetch handler fills it in later */ }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // Fetch with cache:'reload' so a version bump always pulls fresh files,
      // never a stale copy from the browser's HTTP cache.
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(fillImageCache),
    // NOTE: no skipWaiting() here — the new worker waits so the app can prompt
    // the user to update, rather than swapping code out from under them.
  );
});

// The page asks us to activate immediately when the user taps "Update".
self.addEventListener('message', (event) => {
  if (!event.data) return;
  if (event.data.type === 'SKIP_WAITING') self.skipWaiting();
  // The app's "Send a test reminder" button asks us to run the exact same check
  // Chrome's periodic sync would — proving the digest → notification path works,
  // independent of Chrome's (unpredictable) background scheduling. We reply to
  // the page so it can report the outcome to the user.
  if (event.data.type === 'RUN_REMINDER_CHECK') {
    event.waitUntil(
      runDailyReminderCheck({ force: !!event.data.force }).then((result) => {
        if (event.source) event.source.postMessage({ type: 'REMINDER_CHECK_RESULT', ...result });
      }),
    );
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      // Spare IMG_CACHE: the bundled photos are version-independent.
      Promise.all(keys.filter((k) => k !== CACHE && k !== IMG_CACHE).map((k) => caches.delete(k))),
    ).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          // Runtime-cache same-origin GETs so newly added files work offline too.
          if (res.ok && new URL(request.url).origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => caches.match('./index.html'));
    }),
  );
});

// ---- Background reminders (no server) -----------------------------------

// The app writes a "reminderDigest" into IndexedDB; we just read it here.
function idbGetMeta(key) {
  return new Promise((resolve) => {
    const req = indexedDB.open('plant-tracker');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) { resolve(null); return; }
      const g = db.transaction('meta', 'readonly').objectStore('meta').get(key);
      g.onsuccess = () => resolve(g.result ? g.result.value : null);
      g.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

function idbPutMeta(key, value) {
  return new Promise((resolve) => {
    const req = indexedDB.open('plant-tracker');
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) { resolve(false); return; }
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put({ key, value });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => resolve(false);
    };
    req.onerror = () => resolve(false);
  });
}

// ---- Shared reminder formatting (mirror of js/app.js; keep in sync) ------
function reminderDayKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}
function reminderOverdueDays(dueISO, now) {
  const s = (x) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
  return Math.round((s(now) - s(dueISO)) / (24 * 60 * 60 * 1000));
}
function formatReminder(tasks, now, lang) {
  if (!tasks.length) return null;
  const ann = tasks.map((t) => ({ ...t, over: reminderOverdueDays(t.due, now) }));
  return lang === 'nl' ? reminderNL(ann) : reminderEN(ann);
}

// Idiomatic Dutch — written natively, not translated from the English.
function reminderNL(ann) {
  const dagen = (n) => `${n} dag${n === 1 ? '' : 'en'}`;
  if (ann.length === 1) {
    const t = ann[0];
    if (t.over >= 1) {
      if (t.type === 'water') return { title: `🚨 ${t.name} snakt naar water`, body: `Al ${dagen(t.over)} te laat — geef 'm snel water, anders loopt 'ie gevaar.` };
      if (t.type === 'fertilize') return { title: `🌱 ${t.name} heeft voeding nodig`, body: `Al ${dagen(t.over)} te laat met voeden.` };
      return { title: `📸 Tijd voor een nieuwe foto`, body: `Je hebt ${t.name} al ${dagen(t.over)} niet vastgelegd.` };
    }
    if (t.type === 'water') return { title: '🌿 Plantenzorg', body: `${t.name} wil vandaag water.` };
    if (t.type === 'fertilize') return { title: '🌿 Plantenzorg', body: `${t.name} is vandaag toe aan voeding.` };
    return { title: '🌿 Plantenzorg', body: `Maak vandaag een nieuwe foto van ${t.name}.` };
  }
  const n = (type) => ann.filter((t) => t.type === type).length;
  const parts = [];
  if (n('water')) parts.push(`${n('water')} ${n('water') === 1 ? 'plant' : 'planten'} water geven`);
  if (n('fertilize')) parts.push(`${n('fertilize')} ${n('fertilize') === 1 ? 'plant' : 'planten'} voeden`);
  if (n('photo')) parts.push(`${n('photo')} nieuwe foto${n('photo') === 1 ? '' : "'s"}`);
  let body = `${parts.join(', ')}.`;
  const worst = ann.filter((t) => t.over >= 1).sort((a, b) => b.over - a.over)[0];
  if (worst) body += ` ${worst.name} wacht al ${dagen(worst.over)}.`;
  return { title: '🌿 Plantenzorg', body };
}

function reminderEN(ann) {
  const verb = { water: 'watering', fertilize: 'feeding', photo: 'a progress photo' };
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`;
  if (ann.length === 1) {
    const t = ann[0];
    if (t.over >= 1) return { title: `🚨 ${t.name} is overdue`, body: `${days(t.over)} overdue for ${verb[t.type]} — it's at risk.` };
    return { title: '🌿 Plant care', body: `${t.name} needs ${verb[t.type]} today.` };
  }
  const n = (type) => ann.filter((t) => t.type === type).length;
  const parts = [];
  if (n('water')) parts.push(`${n('water')} to water`);
  if (n('fertilize')) parts.push(`${n('fertilize')} to feed`);
  if (n('photo')) parts.push(`${n('photo')} progress photo${n('photo') > 1 ? 's' : ''}`);
  let body = `${parts.join(', ')}.`;
  const worst = ann.filter((t) => t.over >= 1).sort((a, b) => b.over - a.over)[0];
  if (worst) body += ` ${worst.name} is ${days(worst.over)} overdue.`;
  return { title: '🌿 Plant care', body };
}

// Seasonal pruning/repotting nudges — copy is pre-rendered by the app, we just
// gate to once per plant/kind/year and deep-link the tap to the plant's how-to.
async function runSeasonalNudges(digest, now) {
  const seasonal = Array.isArray(digest.seasonal) ? digest.seasonal : [];
  if (!seasonal.length) return;
  const yr = now.getFullYear();
  const slog = (await idbGetMeta('seasonalNudgeLog')) || {};
  for (const n of seasonal) {
    const key = `${n.plantId}|${n.kind}|${yr}`;
    if (slog[key]) continue;
    slog[key] = true;
    await self.registration.showNotification(n.title, {
      body: n.body,
      tag: `plant-seasonal-${n.plantId}-${n.kind}`,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      data: { url: n.url },
    });
  }
  await idbPutMeta('seasonalNudgeLog', slog);
}

// Returns a small summary so the "Send a test reminder" button can tell the
// user what happened: { hasDigest, dueCount, shown, sample }.
//
// opts.force (test only): ALWAYS put a notification on screen — a sample one if
// nothing is actually due — so the user can confirm the background worker can
// display notifications on this device, which is the whole point of the test.
// It also skips the seasonal nudges and the once-per-day de-dup, and never
// touches notifyLog, so a test can't fire early, consume the yearly seasonal
// quota, or suppress the real reminder later today.
async function runDailyReminderCheck(opts = {}) {
  const force = !!opts.force;
  const digest = await idbGetMeta('reminderDigest');
  const now = new Date();
  const lang = (digest && digest.lang) || 'en';

  // What's genuinely due today or overdue, per the last digest the app wrote.
  let due = [];
  if (digest && Array.isArray(digest.tasks)) {
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    due = digest.tasks.filter((t) => {
      const d = new Date(t.due); d.setHours(0, 0, 0, 0);
      return d.getTime() <= startToday.getTime();
    });
  }

  if (force) {
    // Show the real due list if there is one; otherwise a friendly sample so the
    // test still proves the SW → notification path works end to end.
    const list = due.length ? due : [{
      plantId: 'sample',
      name: lang === 'nl' ? 'Voorbeeldplant' : 'Sample plant',
      type: 'water',
      due: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    }];
    const msg = formatReminder(list, now, lang);
    if (!msg) return { hasDigest: !!digest, dueCount: due.length, shown: false };
    try {
      await self.registration.showNotification(msg.title, {
        body: msg.body, tag: 'plant-care-daily', icon: './icons/icon-192.png', badge: './icons/icon-192.png',
      });
      return { hasDigest: !!digest, dueCount: due.length, shown: true, sample: !due.length };
    } catch {
      return { hasDigest: !!digest, dueCount: due.length, shown: false };
    }
  }

  // ---- Normal (Chrome-scheduled) path ----
  if (!digest) return { hasDigest: false, dueCount: 0, shown: false };
  await runSeasonalNudges(digest, now);
  if (!Array.isArray(digest.tasks)) return { hasDigest: true, dueCount: 0, shown: false };
  if (!due.length) { await idbPutMeta('notifyLog', {}); return { hasDigest: true, dueCount: 0, shown: false }; }

  // Once-per-day de-dup, shared with the in-app notifier so the two never
  // double-fire for the same plant on the same day.
  const today = reminderDayKey(now);
  const log = (await idbGetMeta('notifyLog')) || {};
  const fresh = due.filter((t) => log[`${t.plantId}|${t.type}`] !== today);
  const newLog = {};
  for (const t of due) newLog[`${t.plantId}|${t.type}`] = today;
  await idbPutMeta('notifyLog', newLog);
  if (!fresh.length) return { hasDigest: true, dueCount: due.length, shown: false };

  const msg = formatReminder(fresh, now, lang);
  if (!msg) return { hasDigest: true, dueCount: due.length, shown: false };
  await self.registration.showNotification(msg.title, {
    body: msg.body,
    tag: 'plant-care-daily',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
  });
  return { hasDigest: true, dueCount: due.length, shown: true };
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'plant-care-check') event.waitUntil(runDailyReminderCheck());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  // Seasonal nudges carry a deep-link to the plant's how-to; watering reminders
  // have none and just focus the app (its Today list shows what's due).
  const url = event.notification.data && event.notification.data.url;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          if (url) c.postMessage({ type: 'navigate', url });
          return c.focus();
        }
      }
      return self.clients.openWindow ? self.clients.openWindow('./index.html' + (url || '')) : undefined;
    }),
  );
});
