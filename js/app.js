// app.js — Router, views, and all UI for the Plant Care Tracker.

import { el, clear, fmtDate, fmtRelative, todayISO, toDateInputValue, dateInputToISO, fileToResizedDataURL, download, dataUrlToPngBlob, setLocale } from './util.js';
import { getLang, getUnits, localizeDOM, fmtTemp, fmtHeight, heightNum, heightUnit, heightToCm, t } from './i18n.js';
import * as db from './db.js';
import { SPECIES, LIGHT, getSpecies, profileFromSpecies, DEFAULT_PROFILE, allSpecies, isCustomSpecies, registerCustomSpecies } from './species.js';
import { SYMPTOMS, getSymptom, tailorCauses, CATEGORY_LEAD, CATEGORY_NOUN } from './diagnostics.js';
import { seasonForDate, SEASON_META, seasonalExplanation } from './season.js';
import { waterStatus, feedStatus, overallStatus, dueTasks, effectiveWaterInterval, photoStatus, feedCategoryFactor, plantCategory, lastEvent, MS_PER_DAY } from './schedule.js';
import { getSettings, saveSettings } from './settings.js';
import { welcomeMessage, careTips, scheduleWarnings, wateringAmount, pruningRepotTips, seasonalNudges } from './coach.js';
import { buildHandoff, parseHandoffImport, summaryPrompt, speciesPrompt, parseSpeciesImport } from './handoff.js';
import { unitSwitchMessage } from './quips.js';
import { fetchSpeciesImage } from './refphoto.js';
import { symptomArt } from './symptomart.js';
import { SPECIES_PHOTOS, SYMPTOM_PHOTOS } from './refmanifest.js';
import { analyzePlant, lookupSpeciesCare, hasApiKey, AI_MODELS, AIError } from './ai.js';
import * as native from './native.js';
import { buildPlantCareICS } from './calendar.js';

const app = document.getElementById('app');

// Bump this (and the CACHE version in sw.js) on every release so users get the
// update prompt and can see which version they're on in Settings.
const APP_VERSION = '1.3.49';

// ---- Install (PWA) ------------------------------------------------------

// Chromium fires `beforeinstallprompt` only when the app actually qualifies to
// install (HTTPS + valid manifest + service worker). We stash it so an in-app
// button can trigger the native install dialog directly.
let deferredInstallPrompt = null;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

async function triggerInstall() {
  if (!deferredInstallPrompt) {
    toast('Install isn’t available here — see the Install section in Settings.');
    return;
  }
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } catch { /* ignore */ }
  deferredInstallPrompt = null;
  render();
}

// ---- App updates --------------------------------------------------------

let swUpdating = false;

// Show a persistent banner when a newer version has been downloaded and is
// ready. Tapping Update activates it and reloads into the new version.
function showUpdatePrompt(waitingWorker) {
  if (document.getElementById('update-banner')) return;
  const banner = el('div', { id: 'update-banner', class: 'update-banner' }, [
    el('span', { class: 'update-msg' }, '🌱 A new version is ready.'),
    el('button', { class: 'update-btn', onClick: () => {
      swUpdating = true;
      waitingWorker.postMessage({ type: 'SKIP_WAITING' });
    } }, 'Update'),
    el('button', { class: 'update-x', title: 'Later', onClick: () => banner.remove() }, '×'),
  ]);
  document.body.append(banner);
}

// ---- Toast --------------------------------------------------------------

let toastTimer;
function toast(msg, actionLabel, action, duration) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast', class: 'toast' });
    document.body.append(t);
  }
  clear(t);
  t.append(el('span', {}, msg));
  if (actionLabel && action) {
    t.append(el('button', { class: 'toast-action', onClick: () => { action(); hideToast(); } }, actionLabel));
  }
  localizeDOM(t); // toasts are created outside the render pass — translate them here
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, duration || (actionLabel ? 6000 : 3000));
}
function hideToast() {
  const t = document.getElementById('toast');
  if (t) t.classList.remove('show');
}

// ---- Status pill --------------------------------------------------------

function statusPill(level, label) {
  return el('span', { class: `pill pill-${level}` }, label);
}

const STATE_CLASS = { overdue: 'poor', due: 'watch', soon: 'watch', ok: 'good', paused: 'muted' };

// ---- Router -------------------------------------------------------------

const routes = [];
function route(pattern, handler) { routes.push({ pattern, handler }); }

function navigate(hash) { window.location.hash = hash; }

async function render() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  for (const r of routes) {
    const m = hash.match(r.pattern);
    if (m) {
      clear(app);
      app.scrollTop = 0;
      window.scrollTo(0, 0);
      await r.handler(...m.slice(1));
      updateNav(hash);
      localizeDOM(document.body); // translate the rendered view + nav when in Dutch
      refreshReminderState(); // keep the SW's reminder digest fresh (fire-and-forget)
      return;
    }
  }
  clear(app);
  app.append(el('div', { class: 'view' }, 'Not found'));
  localizeDOM(document.body);
}

// One-time repairs for data saved by earlier versions. Guarded by a flag in the
// meta store so each migration runs at most once per device.
async function runMigrations() {
  let done;
  try { done = (await db.getMeta('migrations')) || {}; } catch { return; }

  // v1: an early build dated the auto "Starting photo" at the acquired date
  // (sometimes years ago) instead of when the photo was actually added, making
  // fresh plants look wildly overdue for a progress photo. Re-date those to when
  // the plant was created, and backfill a starting photo for plants that have a
  // main image but no photo event at all.
  if (!done.photoStartDates) {
    try {
      const [plants, events] = await Promise.all([db.getPlants(), db.getEvents()]);
      for (const p of plants) {
        const created = new Date(p.createdAt);
        const photoEvents = events.filter((e) => e.plantId === p.id && e.type === 'photo');
        for (const e of photoEvents) {
          if (e.notes === 'Starting photo' && (created - new Date(e.date)) > 2 * MS_PER_DAY) {
            e.date = created.toISOString();
            await db.putEvent(e);
          }
        }
        if (p.photo && photoEvents.length === 0) {
          await db.putEvent({ id: db.uid('ev'), plantId: p.id, type: 'photo', date: created.toISOString(), photo: p.photo, notes: 'Starting photo' });
        }
      }
      done.photoStartDates = true;
      await db.putMeta('migrations', done);
    } catch { /* leave unflagged so it retries next launch */ }
  }
}

// Persist a lightweight "what's due" digest that the service worker reads for
// background reminders (it can't run our seasonal math itself).
//
// We include tasks due within the next week, not just already-due ones: the
// background worker only ever sees this digest (last written when the app was
// open), so without a look-ahead a plant that crosses into "due" while the app
// is closed would be invisible and never trigger a reminder. The SW gates each
// task on its real due date (see sw.js), so listing upcoming tasks here never
// fires a reminder early.
const REMINDER_LOOKAHEAD_DAYS = 7;
async function refreshReminderState() {
  try {
    const settings = getSettings();
    const now = new Date();
    const [plants, events] = await Promise.all([db.getPlants(), db.getEvents()]);
    const tasks = dueTasks(plants, events, now, settings.hemisphere, REMINDER_LOOKAHEAD_DAYS)
      .map((t) => ({ plantId: t.plant.id, name: t.plant.name, type: t.type, due: t.due.toISOString() }));
    const photoDue = plants.filter((p) => photoStatus(p, events, now).due)
      .map((p) => ({ plantId: p.id, name: p.name, type: 'photo', due: now.toISOString() }));
    // Seasonal pruning/repotting nudges, pre-rendered in the current language so
    // the service worker can show them without re-running the seasonal math.
    const seasonal = gatherSeasonalNudges(plants, events, settings, now);
    await db.putMeta('reminderDigest', { tasks: tasks.concat(photoDue), seasonal, generatedAt: now.toISOString(), lang: settings.lang || 'en' });
  } catch { /* ignore */ }
}

// Collect this-spring's pruning/repotting nudges across all plants. Each entry
// carries the finished notification copy plus a deep-link so a tap lands on the
// plant's how-to. Empty outside spring / when nothing is due.
function gatherSeasonalNudges(plants, events, settings, now) {
  const out = [];
  for (const p of plants) {
    const lp = lastEvent(events, p.id, 'prune');
    const lr = lastEvent(events, p.id, 'repot');
    const nudges = seasonalNudges(p, settings, now, {
      lastPrune: lp ? new Date(lp.date) : null,
      lastRepot: lr ? new Date(lr.date) : null,
    });
    for (const n of nudges) {
      out.push({ plantId: p.id, name: p.name, kind: n.kind, title: n.title, body: n.body, url: `#/plant/${p.id}` });
    }
  }
  return out;
}

function updateNav(hash) {
  document.querySelectorAll('.nav-item').forEach((n) => {
    const target = n.dataset.target;
    const active =
      (target === '/today' && (hash === '/' || hash.startsWith('/today'))) ||
      (target === '/plants' && (hash.startsWith('/plants') || hash.startsWith('/plant/') || hash.startsWith('/add') || hash.startsWith('/edit'))) ||
      (target === '/guide' && (hash.startsWith('/guide') || hash.startsWith('/diagnose'))) ||
      (target === '/settings' && hash.startsWith('/settings'));
    n.classList.toggle('active', active);
  });
}

// ---- Header helper ------------------------------------------------------

function viewHeader(title, { back = null, actions = [] } = {}) {
  const left = back
    ? el('button', { class: 'icon-btn', title: 'Back', onClick: () => (back === true ? history.back() : navigate(back)) }, '‹')
    : el('span', { class: 'logo' }, '🌿');
  return el('header', { class: 'view-header' }, [
    left,
    el('h1', {}, title),
    el('div', { class: 'header-actions' }, actions),
  ]);
}

// =========================================================================
// TODAY / DASHBOARD
// =========================================================================

route(/^\/(today)?$/, async () => {
  const settings = getSettings();
  const now = new Date();
  const [plants, events] = await Promise.all([db.getPlants(), db.getEvents()]);
  const season = seasonForDate(now, settings.hemisphere);
  const meta = SEASON_META[season];

  const view = el('div', { class: 'view' });
  view.append(viewHeader('Today', {
    actions: [el('button', { class: 'icon-btn', title: 'Add plant', onClick: () => navigate('/add') }, '＋')],
  }));

  // Offer to install as a real app (only shows when the browser says it can).
  if (deferredInstallPrompt && !isStandalone() && !sessionStorage.getItem('hideInstall')) {
    view.append(el('div', { class: 'install-banner' }, [
      el('span', { class: 'install-emoji' }, '📲'),
      el('div', { class: 'install-text' }, [
        el('div', { class: 'install-title' }, 'Install Plant Tracker'),
        el('div', { class: 'install-sub' }, 'Add it to your home screen as a full app'),
      ]),
      el('button', { class: 'install-btn', onClick: triggerInstall }, 'Install'),
      el('button', { class: 'install-x', title: 'Dismiss', onClick: () => { sessionStorage.setItem('hideInstall', '1'); render(); } }, '×'),
    ]));
  }

  // Season banner
  view.append(el('div', { class: 'season-banner' }, [
    el('div', { class: 'season-emoji' }, meta.emoji),
    el('div', {}, [
      el('div', { class: 'season-title' }, `${meta.label} · ${settings.hemisphere === 'N' ? 'Northern' : 'Southern'} hemisphere`),
      el('div', { class: 'season-note' }, meta.note),
    ]),
  ]));

  if (plants.length === 0) {
    view.append(emptyState(
      '🪴', 'No plants yet',
      'Add your first plant to start tracking watering, feeding and health.',
      'Add a plant', () => navigate('/add'),
    ));
    app.append(view);
    return;
  }

  const overdue = dueTasks(plants, events, now, settings.hemisphere, 0);
  const upcoming = dueTasks(plants, events, now, settings.hemisphere, 3).filter((t) => t.daysUntil > 0);

  // Summary counts
  const stats = plants.map((p) => overallStatus(p, events, now, settings.hemisphere));
  const counts = { good: 0, watch: 0, poor: 0 };
  stats.forEach((s) => counts[s.level]++);
  view.append(el('div', { class: 'stat-row' }, [
    statCard(counts.good, 'Healthy', 'good'),
    statCard(counts.watch, 'Needs care', 'watch'),
    statCard(counts.poor, 'At risk', 'poor'),
  ]));

  // Due now
  view.append(el('h2', { class: 'section-title' }, overdue.length ? `Needs care now (${overdue.length})` : 'Needs care now'));
  if (overdue.length === 0) {
    view.append(el('div', { class: 'all-done' }, ['✅ ', 'All caught up — nothing due today.']));
  } else {
    const list = el('div', { class: 'task-list' });
    overdue.forEach((t) => list.append(taskRow(t, now, () => render())));
    view.append(list);
  }

  // Upcoming
  if (upcoming.length) {
    view.append(el('h2', { class: 'section-title' }, 'Coming up'));
    const list = el('div', { class: 'task-list' });
    upcoming.forEach((t) => list.append(taskRow(t, now, () => render(), true)));
    view.append(list);
  }

  // Seasonal care — spring nudges to prune/repot. Tapping opens the plant, where
  // the Pruning & repotting card has the full how-to.
  const seasonalList = gatherSeasonalNudges(plants, events, settings, now);
  if (seasonalList.length) {
    view.append(el('h2', { class: 'section-title' }, 'Seasonal care'));
    const list = el('div', { class: 'task-list' });
    seasonalList.forEach((n) => {
      const plant = plants.find((p) => p.id === n.plantId);
      list.append(el('div', { class: 'task-row', onClick: () => navigate(`/plant/${n.plantId}`) }, [
        plantThumb(plant, 44),
        el('div', { class: 'task-main' }, [
          el('div', { class: 'task-name' }, `${n.kind === 'repot' ? '🪴' : '✂️'} ${n.name}`),
          el('div', { class: 'task-sub' }, n.body),
        ]),
        el('span', { class: 'task-chevron' }, '›'),
      ]));
    });
    view.append(list);
  }

  // Progress photos due — with a one-tap camera shortcut on each.
  const photoDue = plants.filter((p) => photoStatus(p, events, now).due);
  if (photoDue.length) {
    view.append(el('h2', { class: 'section-title' }, `Progress photos (${photoDue.length})`));
    const list = el('div', { class: 'task-list' });
    photoDue.forEach((p) => {
      list.append(el('div', { class: 'task-row', onClick: () => navigate(`/plant/${p.id}`) }, [
        plantThumb(p, 44),
        el('div', { class: 'task-main' }, [
          el('div', { class: 'task-name' }, p.name),
          el('div', { class: 'task-sub' }, '📸 Time for a fresh health photo'),
        ]),
        quickPhotoButton(p, { className: 'do-btn photo-do', label: '📷 Photo', stopProp: true }),
      ]));
    });
    view.append(list);
  }

  app.append(view);
});

function statCard(n, label, level) {
  return el('div', { class: `stat-card stat-${level}` }, [
    el('div', { class: 'stat-num' }, String(n)),
    el('div', { class: 'stat-label' }, label),
  ]);
}

function taskRow(task, now, onDone, upcoming = false) {
  const isWater = task.type === 'water';
  const icon = isWater ? '💧' : '🌱';
  const verb = isWater ? 'Water' : 'Feed';
  const cls = STATE_CLASS[task.state] || 'muted';
  const when = task.daysUntil < 0
    ? `${-task.daysUntil} days overdue`
    : task.daysUntil === 0 ? 'due today' : fmtRelative(task.daysUntil);

  const row = el('div', { class: `task-row task-${cls}`, onClick: () => navigate(`/plant/${task.plant.id}`) }, [
    plantThumb(task.plant, 44),
    el('div', { class: 'task-main' }, [
      el('div', { class: 'task-name' }, task.plant.name),
      el('div', { class: 'task-sub' }, [`${icon} ${verb} · `, el('span', { class: `when when-${cls}` }, when)]),
      // Show how much at a glance, so people don't have to open the plant to
      // learn whether it wants a splash or a full soak (overwatering is the #1
      // killer). Only for watering — feeding amount is set once in Settings.
      isWater ? el('div', { class: 'task-amount' }, `💧 ${wateringAmount(task.plant).label}`) : null,
    ]),
  ]);
  if (!upcoming) {
    row.append(el('button', {
      class: 'do-btn',
      onClick: async (e) => {
        e.stopPropagation();
        await logCare(task.plant.id, task.type);
        toast(`${task.plant.name}: logged ${isWater ? 'watering' : 'feeding'}`);
        onDone();
      },
    }, isWater ? 'Water' : 'Feed'));
  }
  return row;
}

async function logCare(plantId, type, dateISO = todayISO(), extra = {}) {
  await db.putEvent({
    id: db.uid('ev'),
    plantId,
    type,
    date: dateInputToISO(dateISO),
    ...extra,
  });
}

// =========================================================================
// MY PLANTS
// =========================================================================

route(/^\/plants$/, async () => {
  const settings = getSettings();
  const now = new Date();
  const [plants, events] = await Promise.all([db.getPlants(), db.getEvents()]);

  const view = el('div', { class: 'view' });
  view.append(viewHeader('My Plants', {
    actions: [el('button', { class: 'icon-btn', title: 'Add plant', onClick: () => navigate('/add') }, '＋')],
  }));

  if (plants.length === 0) {
    view.append(emptyState('🪴', 'No plants yet', 'Add your first plant to get started.', 'Add a plant', () => navigate('/add')));
    app.append(view);
    return;
  }

  const grid = el('div', { class: 'plant-grid' });
  for (const p of plants) {
    const st = overallStatus(p, events, now, settings.hemisphere);
    const w = st.water;
    const waterWhen = scheduleWhenText(w.daysUntil);
    grid.append(el('div', { class: 'plant-card', onClick: () => navigate(`/plant/${p.id}`) }, [
      el('div', { class: 'plant-card-photo' }, [plantThumb(p, 0)]),
      el('div', { class: 'plant-card-body' }, [
        el('div', { class: 'plant-card-top' }, [
          el('div', { class: 'plant-card-name' }, p.name),
          el('span', { class: `dot dot-${st.level}`, title: st.label }),
        ]),
        el('div', { class: 'plant-card-species' }, speciesLabel(p)),
        el('div', { class: `plant-card-water when-${STATE_CLASS[w.state]}` }, `💧 ${waterWhen}`),
      ]),
    ]));
  }
  view.append(grid);
  app.append(view);
});

function speciesLabel(p) {
  const s = p.speciesId ? getSpecies(p.speciesId) : null;
  return s ? s.name : (p.latin || 'Custom plant');
}

// Photo thumbnail or emoji fallback. size 0 => fill container.
function plantThumb(plant, size = 48) {
  if (plant.photo) {
    const img = el('img', { class: 'thumb', src: plant.photo, alt: plant.name });
    if (size) { img.style.width = size + 'px'; img.style.height = size + 'px'; }
    return img;
  }
  const s = plant.speciesId ? getSpecies(plant.speciesId) : null;
  const emoji = categoryEmoji(s ? s.category : null);
  const ph = el('div', { class: 'thumb thumb-ph' }, emoji);
  if (size) { ph.style.width = size + 'px'; ph.style.height = size + 'px'; ph.style.fontSize = Math.round(size * 0.5) + 'px'; }
  return ph;
}

function categoryEmoji(cat) {
  return ({
    succulent: '🌵', 'tropical-foliage': '🌿', fern: '🌿', orchid: '🌸',
    flowering: '🌼', herb: '🌱',
  })[cat] || '🪴';
}

const CAT_LABEL = {
  'tropical-foliage': 'Tropical foliage', succulent: 'Succulents & cacti',
  fern: 'Ferns', orchid: 'Orchids', flowering: 'Flowering', herb: 'Herbs', other: 'Other',
};

// Options for the form's "Plant type" picker (value → label). Matches the
// categories the care database and AI/paste lookups use.
const PLANT_CATEGORIES = [
  ['tropical-foliage', 'Tropical foliage (pothos, monstera…)'],
  ['succulent', 'Succulent / cactus'],
  ['flowering', 'Flowering plant'],
  ['herb', 'Herb'],
  ['fern', 'Fern'],
  ['orchid', 'Orchid'],
  ['other', 'Other / not sure'],
];

// Human-readable summary of a plant's pot/spot conditions (empty if none set).
function conditionsSummary(c) {
  if (!c) return '';
  const map = {
    potSize: { small: 'small pot', medium: 'medium pot', large: 'large pot' },
    potMaterial: { terracotta: 'terracotta', plastic: 'plastic', ceramic: 'glazed ceramic', metal: 'metal' },
    drainage: { yes: 'good drainage', no: 'no drainage' },
    lightSpot: { low: 'low light', medium: 'medium light', bright: 'bright light' },
  };
  const parts = [];
  for (const k of ['potSize', 'potMaterial', 'drainage', 'lightSpot']) {
    if (c[k] && map[k][c[k]]) parts.push(map[k][c[k]]);
  }
  return parts.join(' · ');
}

async function reloadCustomSpecies() {
  try { registerCustomSpecies(await db.getCustomSpecies()); } catch { /* ignore */ }
}

// (Re)build the species <select>: built-in groups + a "My saved species" group.
function buildSpeciesOptions(sel, selectedId) {
  clear(sel);
  sel.append(el('option', { value: '' }, '— Choose a species (autofills care) —'));
  const cats = {};
  SPECIES.forEach((s) => { (cats[s.category] ||= []).push(s); });
  for (const cat of Object.keys(cats)) {
    const g = el('optgroup', { label: CAT_LABEL[cat] || cat });
    cats[cat].forEach((s) => g.append(el('option', { value: s.id }, s.name)));
    sel.append(g);
  }
  const custom = allSpecies().filter((s) => isCustomSpecies(s.id));
  if (custom.length) {
    const g = el('optgroup', { label: 'My saved species' });
    custom.forEach((s) => g.append(el('option', { value: s.id }, s.name)));
    sel.append(g);
  }
  sel.append(el('option', { value: '__custom' }, 'Custom / not listed'));
  if (selectedId != null) sel.value = selectedId;
}

// Find a library species (built-in or saved) matching a name/latin guess.
function findSpeciesByName(name) {
  if (!name) return null;
  const q = name.trim().toLowerCase();
  if (!q) return null;
  const all = allSpecies();
  const exact = all.find((s) =>
    s.name.toLowerCase() === q ||
    (s.latin || '').toLowerCase() === q ||
    (s.aka || []).some((a) => a.toLowerCase() === q));
  if (exact) return exact;
  if (q.length < 4) return null;
  return all.find((s) =>
    s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase()) ||
    (s.latin && (s.latin.toLowerCase().includes(q) || q.includes(s.latin.toLowerCase())))) || null;
}

// Put a photo on the clipboard (PNG); falls back to the share sheet.
async function copyPhotoToClipboard(dataUrl) {
  const blob = await dataUrlToPngBlob(dataUrl);
  if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return;
  }
  if (navigator.canShare) {
    const file = new File([blob], 'plant.png', { type: 'image/png' });
    if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  }
  throw new Error('unsupported');
}

// Get species care (or identify from a photo) by pasting a prompt into your own
// Claude/ChatGPT — no API key. onCare(careObj) applies + saves it.
function openSpeciesPasteDialog(name, onCare, photoDataUrl = null) {
  const identifying = !!photoDataUrl && !name;
  const prompt = speciesPrompt(name, { fromPhoto: !!photoDataUrl });
  const promptArea = el('textarea', { class: 'field handoff-text', rows: 6, readonly: 'readonly', spellcheck: 'false' });
  promptArea.value = prompt;
  const copyBtn = el('button', { class: 'btn btn-primary full', onClick: async () => {
    try { await navigator.clipboard.writeText(prompt); toast('Copied — paste into Claude or ChatGPT'); }
    catch { promptArea.focus(); promptArea.select(); toast('Select all, then copy (Ctrl/Cmd+C)'); }
  } }, '📋 Copy prompt');

  let photoRow = null;
  if (photoDataUrl) {
    photoRow = el('div', { class: 'handoff-photo' }, [
      el('img', { src: photoDataUrl, alt: 'plant photo' }),
      el('div', { class: 'handoff-photo-side' }, [
        el('button', { class: 'btn btn-secondary full', onClick: async () => {
          try { await copyPhotoToClipboard(photoDataUrl); toast('Photo copied — paste it into your AI'); }
          catch { toast('Press and hold the photo to copy it'); }
        } }, '📷 Copy photo'),
        el('div', { class: 'hint' }, 'Paste the prompt into your AI, then paste the photo so it can identify the plant.'),
      ]),
    ]);
  }

  const pasteArea = el('textarea', { class: 'field', rows: 5, placeholder: 'Paste your AI’s reply here — the ```plant-species block…' });
  const result = el('div', { class: 'id-note' });
  const importBtn = el('button', { class: 'btn btn-secondary full', onClick: async () => {
    clear(result);
    const c = parseSpeciesImport(pasteArea.value);
    if (!c) { result.append('⚠️ Couldn’t read a plant-species block. Copy your AI’s whole reply, including the code block.'); return; }
    m.close();
    await onCare(c);
  } }, identifying ? 'Identify & add' : 'Add to my library');

  const children = [
    el('h3', { class: 'modal-title' }, identifying ? '📸 Identify with your own AI' : '📋 Get care info from your own AI'),
    el('div', { class: 'hint' }, identifying
      ? 'No API key needed — copy this prompt and the photo into Claude or ChatGPT, then paste its reply back to identify and add this plant.'
      : 'No API key needed — copy this prompt into Claude or ChatGPT, then paste its reply back to add this plant to your library.'),
    el('div', { class: 'handoff-step' }, '1 · Copy the prompt (and photo) into your AI'),
    promptArea,
    copyBtn,
    photoRow,
    el('div', { class: 'handoff-step' }, '2 · Paste the reply'),
    pasteArea,
    importBtn,
    result,
    el('button', { class: 'btn btn-ghost full', onClick: () => m.close() }, 'Close'),
  ].filter(Boolean);
  const m = modal(children);
}

// Persist an AI-looked-up species to the reusable library (dedupe by name/latin).
async function saveLookedUpSpecies(c) {
  const latin = (c.latin_name || '').trim().toLowerCase();
  const common = (c.common_name || '').trim().toLowerCase();
  const existing = allSpecies().find((s) => isCustomSpecies(s.id) &&
    ((latin && (s.latin || '').toLowerCase() === latin) ||
     (common && (s.name || '').toLowerCase() === common)));
  if (existing) return existing.id;

  const slug = (c.common_name || c.latin_name || 'plant').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'plant';
  const id = `cust_${slug}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const species = {
    id,
    name: c.common_name || c.latin_name || 'Custom plant',
    latin: c.latin_name || '',
    aka: [],
    category: c.category || 'other',
    water: Math.max(1, c.water_interval_days || 7),
    winterFactor: c.winter_factor || 1.5,
    fertilize: Math.max(0, Number.isInteger(c.fertilize_interval_days) ? c.fertilize_interval_days : 30),
    feedWinter: !!c.feed_winter,
    light: c.light || 'medium',
    humidity: c.humidity || 'Average',
    tempMin: Number.isFinite(c.temp_min_c) ? c.temp_min_c : 13,
    toxic: c.toxicity || 'Unknown',
    difficulty: c.difficulty || 'moderate',
    soil: c.soil || 'Well-draining potting mix',
    tips: c.tips || '',
    custom: true,
  };
  await db.putCustomSpecies(species);
  await reloadCustomSpecies();
  return id;
}

// =========================================================================
// PLANT DETAIL
// =========================================================================

// Shared, per-species cache for Wikipedia reference photos, so the guide page
// and every logged plant of the same species fetch it exactly once between
// them. Failures are remembered (triedAt) and only retried weekly.
async function getRefPhotoCached(cacheKey, candidates) {
  if (!cacheKey) return null;
  const key = `refphoto:${String(cacheKey).toLowerCase()}`;
  const hit = await db.getMeta(key);
  if (hit && hit.img) return hit.img;
  if (hit && hit.triedAt && Date.now() - new Date(hit.triedAt).getTime() < 7 * MS_PER_DAY) return null;
  if (navigator.onLine === false) return null;
  const img = await fetchSpeciesImage(candidates);
  await db.putMeta(key, { img: img || null, triedAt: new Date().toISOString() });
  return img;
}

// The reference-photo card used by the guide, the plant page and the
// troubleshooter. Handles both bundled manifest entries ({file, title, artist,
// license…}) and runtime-fetched ones ({dataUrl, pageTitle…}), and renders the
// credit line the Commons licenses require.
function refPhotoCard(img, label = 'Species reference') {
  const src = img.file || img.dataUrl;
  const title = img.title || img.pageTitle || '';
  const credit = [img.artist, img.license].filter(Boolean).join(' · ');
  return el('div', { class: 'ref-card' }, [
    el('img', { src, alt: title || 'reference photo', loading: 'lazy', onClick: () => openImage(src, title) }),
    el('div', { class: 'ref-cap' }, [
      el('span', {}, label),
      el('span', {}, ' · '),
      el('a', { href: img.pageUrl, target: '_blank', rel: 'noopener', 'data-noloc': '1' }, 'Wikipedia ↗'),
      credit ? el('div', { class: 'ref-credit', 'data-noloc': '1' }, [
        img.licenseUrl
          ? el('a', { href: img.licenseUrl, target: '_blank', rel: 'noopener' }, credit)
          : credit,
      ]) : null,
    ]),
  ]);
}

route(/^\/plant\/(.+)$/, async (id) => {
  const settings = getSettings();
  const now = new Date();
  const plant = await db.getPlant(id);
  if (!plant) { navigate('/plants'); return; }
  const events = await db.getEvents(id);
  const st = overallStatus(plant, events, now, settings.hemisphere);
  const season = seasonForDate(now, settings.hemisphere);

  const view = el('div', { class: 'view' });
  view.append(viewHeader(plant.name, {
    back: '/plants',
    actions: [el('button', { class: 'icon-btn', title: 'Edit', onClick: () => navigate(`/edit/${id}`) }, '✏️')],
  }));

  // Hero
  view.append(el('div', { class: 'detail-hero' }, [
    el('div', { class: 'detail-hero-photo' }, [plantThumb(plant, 0)]),
    el('div', { class: 'detail-hero-info' }, [
      statusPill(st.level, st.label),
      el('div', { class: 'detail-species' }, speciesLabel(plant)),
      plant.latin ? el('div', { class: 'detail-latin' }, plant.latin) : null,
      plant.location ? el('div', { class: 'detail-meta' }, `📍 ${plant.location}`) : null,
    ]),
  ]));

  // Seasonal note for this plant
  view.append(el('div', { class: 'season-inline' }, [
    `${SEASON_META[season].emoji} ${SEASON_META[season].label}: `,
    seasonalExplanation(season, plant.profile),
  ]));
  const condSummary = conditionsSummary(plant.conditions);
  if (condSummary) view.append(el('div', { class: 'season-inline' }, [`🪴 Personalized for its pot & spot: ${condSummary}`]));

  // AI health check — the standout "let me look at your plant" action.
  view.append(el('button', { class: 'ai-cta', onClick: () => openAIDialog(plant) }, [
    el('span', { class: 'ai-cta-icon' }, '✨'),
    el('div', { class: 'ai-cta-body' }, [
      el('div', { class: 'ai-cta-title' }, 'AI health check'),
      el('div', { class: 'ai-cta-sub' }, 'Show a photo and get an expert read on how it’s doing'),
    ]),
    el('span', { class: 'ai-cta-arrow' }, '›'),
  ]));
  // Free alternative: hand the conversation to your own Claude/ChatGPT.
  view.append(el('button', { class: 'handoff-link', onClick: () => openHandoffDialog(plant) },
    '💬 Or continue in your own Claude / ChatGPT (free)'));
  // Symptom troubleshooter, tailored to this plant (works even for custom plants
  // with no library species — it uses the plant's own category).
  view.append(el('button', { class: 'handoff-link', onClick: () => navigate(`/diagnose/plant/${plant.id}`) },
    '🔍 Troubleshoot a symptom (yellow leaves, pests…)'));

  // Schedule cards
  const w = st.water;
  const f = st.feed;
  const sched = el('div', { class: 'schedule-cards' });
  sched.append(scheduleCard({
    icon: '💧', title: 'Water',
    every: `every ${w.interval} days`,
    last: w.everDone ? fmtDate(w.lastDate) : 'not yet logged',
    due: w.due, daysUntil: w.daysUntil, state: w.state,
    onDo: async () => { await logCare(id, 'water'); toast('Watering logged'); render(); },
    onDoDated: () => openLogDialog(plant, 'water'),
    doLabel: 'Log watering',
    foot: `💧 ${wateringAmount(plant).label}`,
  }));
  if (f) {
    sched.append(scheduleCard({
      icon: '🌱', title: 'Feed',
      every: `every ${f.interval} days`,
      last: f.everDone ? fmtDate(f.lastDate) : 'not yet logged',
      due: f.due, daysUntil: f.daysUntil, state: f.state, paused: f.state === 'paused',
      onDo: async () => { await logCare(id, 'fertilize'); toast('Feeding logged'); render(); },
      onDoDated: () => openLogDialog(plant, 'fertilize'),
      doLabel: 'Log feeding',
      foot: (() => {
        const parts = [];
        if (settings.feed && settings.feed.name) parts.push(`🧪 ${settings.feed.name}`);
        const sp = plant.speciesId ? getSpecies(plant.speciesId) : null;
        const factor = feedCategoryFactor(sp ? sp.category : 'other');
        if (factor < 1) parts.push('hungry feeder — fed more often');
        else if (factor > 1) parts.push('light feeder — fed sparingly');
        return parts.length ? parts.join(' · ') : null;
      })(),
    }));
  }
  view.append(sched);

  // Quick log actions
  view.append(el('div', { class: 'quick-actions' }, [
    quickBtn('💧', 'Water', () => quickLog(id, 'water')),
    quickBtn('🌱', 'Feed', () => quickLog(id, 'fertilize')),
    quickBtn('❤️', 'Health', () => openHealthDialog(plant)),
    quickBtn('📷', 'Photo', () => openPhotoDialog(plant)),
    quickBtn('✂️', 'More', () => openMoreDialog(plant)),
  ]));

  // Care coach — warm, plain-language "how to keep it thriving" guidance.
  view.append(el('h2', { class: 'section-title' }, 'Care coach'));
  const coachTips = careTips(plant, settings, now);
  view.append(el('div', { class: 'coach-card' }, [
    el('div', { class: 'coach-avatar' }, '🌿'),
    el('div', { class: 'coach-body' }, [
      el('div', { class: 'coach-msg' }, welcomeMessage(plant, settings, now)),
      el('ul', { class: 'coach-tips' }, coachTips.map((t) =>
        el('li', {}, [el('span', { class: 'coach-tip-icon' }, t.icon), el('span', {}, t.text)]),
      )),
    ]),
  ]));

  // What healthy looks like — a species reference photo (fetched once from
  // Wikipedia, stored on-device) next to the owner's own best "good" photo.
  const bestOwn = events.find((e) => e.type === 'health' && e.photo && e.health === 'good');
  // Bundled photo first (built-in species, instant + offline); the stored
  // runtime-fetched one covers custom species.
  const refImg = (plant.speciesId && SPECIES_PHOTOS[plant.speciesId]) || plant.refPhoto;
  if (refImg || bestOwn) {
    view.append(el('h2', { class: 'section-title' }, 'What healthy looks like'));
    const refGrid = el('div', { class: 'ref-grid' });
    if (refImg) refGrid.append(refPhotoCard(refImg));
    if (bestOwn) {
      refGrid.append(el('div', { class: 'ref-card' }, [
        el('img', { src: bestOwn.photo, alt: 'your plant at its best', onClick: () => openImage(bestOwn.photo, fmtDate(bestOwn.date)) }),
        el('div', { class: 'ref-cap' }, [
          el('span', {}, 'Yours at its best'),
          el('span', {}, ` · ${fmtDate(bestOwn.date)}`),
        ]),
      ]));
    }
    view.append(refGrid);
  }
  // Fetch the reference once, in the background, the first time this page is
  // open while online. Throttled via refPhotoTried so a species Wikipedia
  // doesn't know isn't retried on every visit.
  if (!refImg && navigator.onLine !== false) {
    const tried = plant.refPhotoTried ? Date.now() - new Date(plant.refPhotoTried).getTime() : Infinity;
    if (tried > 7 * MS_PER_DAY) {
      (async () => {
        plant.refPhotoTried = new Date().toISOString();
        const sp = plant.speciesId ? getSpecies(plant.speciesId) : null;
        const cacheKey = (sp && sp.latin) || plant.latin || (sp && sp.name) || plant.name;
        const img = await getRefPhotoCached(cacheKey, [
          (sp && sp.latin) || plant.latin,
          plant.latin,
          sp && sp.name,
        ]);
        if (img) plant.refPhoto = img;
        await db.putPlant(plant);
        // Only re-render if the user is still looking at this plant.
        if (img && location.hash.includes(id)) render();
      })();
    }
  }

  // Pruning & repotting — seasonal, plant-type guidance for "when the time comes",
  // made time-aware by the last logged prune/repot, with a one-tap log on each.
  const lastPruneEv = lastEvent(events, id, 'prune');
  const lastRepotEv = lastEvent(events, id, 'repot');
  const prTips = pruningRepotTips(plant, settings, now, {
    lastPrune: lastPruneEv ? new Date(lastPruneEv.date) : null,
    lastRepot: lastRepotEv ? new Date(lastRepotEv.date) : null,
  });
  const nlLang = getLang() === 'nl';
  const lastEvByKind = { prune: lastPruneEv, repot: lastRepotEv };
  const kindLabel = {
    prune: nlLang ? 'Laatst gesnoeid' : 'Last pruned',
    repot: nlLang ? 'Laatst verpot' : 'Last repotted',
  };
  view.append(el('h2', { class: 'section-title' }, 'Pruning & repotting'));
  view.append(el('div', { class: 'coach-card' }, [
    el('div', { class: 'coach-avatar' }, '✂️'),
    el('div', { class: 'coach-body' }, [
      el('ul', { class: 'coach-tips' }, prTips.map((t) => {
        const last = lastEvByKind[t.kind];
        const lastText = last
          ? `${kindLabel[t.kind]}: ${fmtDate(last.date)}`
          : `${kindLabel[t.kind]}: ${nlLang ? 'nog niet gelogd' : 'not logged yet'}`;
        return el('li', {}, [
          el('span', { class: 'coach-tip-icon' }, t.icon),
          el('div', { class: 'pr-tip-body' }, [
            el('div', {}, t.text),
            el('div', { class: 'pr-last' }, [
              el('span', {}, lastText),
              el('button', {
                class: 'pr-log-btn',
                onClick: () => openMoreDialog(plant, t.kind),
              }, nlLang ? 'Loggen' : 'Log'),
            ]),
          ]),
        ]);
      })),
    ]),
  ]));

  // Care requirements
  const pr = plant.profile;
  view.append(el('h2', { class: 'section-title' }, 'Care needs'));
  view.append(el('div', { class: 'care-grid' }, [
    careItem('☀️', 'Light', LIGHT[pr.light] || pr.light),
    careItem('💧', 'Water', `Every ${pr.water} days (growing season)`),
    careItem('💦', 'Humidity', pr.humidity),
    careItem('🌡️', 'Min temp', fmtTemp(pr.tempMin)),
    careItem('🌱', 'Feed', pr.fertilize ? `Every ${pr.fertilize} days in season` : 'Rarely'),
    careItem('🪴', 'Soil', pr.soil),
    careItem('🐾', 'Toxicity', pr.toxic),
    careItem('📈', 'Difficulty', difficultyLabel(pr.difficulty)),
  ]));
  if (pr.tips) {
    view.append(el('div', { class: 'tips-box' }, ['💡 ', pr.tips]));
  }

  // Photo progression + "time for a fresh photo" reminder
  const photos = events.filter((e) => e.photo).sort((a, b) => new Date(a.date) - new Date(b.date));
  const ps = photoStatus(plant, events, now);
  view.append(el('h2', { class: 'section-title' }, `Photo progression${photos.length ? ` (${photos.length})` : ''}`));
  if (ps.due) {
    view.append(el('div', { class: 'photo-nudge' }, [
      el('span', { class: 'photo-nudge-icon' }, '📸'),
      el('div', { class: 'photo-nudge-text' }, [
        el('div', { class: 'photo-nudge-title' }, ps.last ? 'Time for a fresh health photo' : 'Add a starting photo'),
        el('div', { class: 'photo-nudge-sub' }, ps.last
          ? `It's been ${ps.daysSince} days since the last one — snap a new photo to track how it's doing.`
          : 'Snap one now to start tracking its progress over time.'),
      ]),
      quickPhotoButton(plant, { className: 'photo-nudge-btn', label: '📷 Take photo' }),
    ]));
  }
  if (photos.length) {
    const strip = el('div', { class: 'photo-strip' });
    photos.forEach((e) => {
      strip.append(el('figure', { class: 'photo-item', onClick: () => openImage(e.photo, fmtDate(e.date)) }, [
        el('img', { src: e.photo, alt: fmtDate(e.date) }),
        el('figcaption', {}, fmtDate(e.date)),
      ]));
    });
    view.append(strip);
  }
  view.append(quickPhotoButton(plant, { className: 'btn btn-secondary full' }));

  // Growth — height over time
  const heightPts = events
    .filter((e) => e.type === 'growth' && Number.isFinite(e.height))
    .map((e) => ({ date: new Date(e.date), value: e.height }))
    .sort((a, b) => a.date - b.date);
  view.append(el('h2', { class: 'section-title' }, 'Growth'));
  if (heightPts.length >= 2) {
    const first = heightPts[0], last = heightPts[heightPts.length - 1];
    const change = Math.round((last.value - first.value) * 10) / 10;
    const minY = Math.min(...heightPts.map((p) => p.value));
    const maxY = Math.max(...heightPts.map((p) => p.value));
    view.append(el('div', { class: 'growth-head' }, [
      el('span', { class: 'growth-latest' }, fmtHeight(last.value)),
      el('span', { class: `growth-change ${change >= 0 ? 'up' : 'down'}` },
        `${change >= 0 ? '▲' : '▼'} ${heightNum(Math.abs(change))} ${heightUnit()} ${getLang() === 'nl' ? 'sinds' : 'since'} ${fmtDate(first.date)}`),
    ]));
    view.append(growthChart(heightPts));
    view.append(el('div', { class: 'growth-caption' }, `${heightNum(minY)}–${heightNum(maxY)} ${heightUnit()} · ${fmtDate(first.date)} → ${fmtDate(last.date)}`));
  } else if (heightPts.length === 1) {
    view.append(el('div', { class: 'muted-box' }, `${getLang() === 'nl' ? 'Laatste hoogte' : 'Latest height'}: ${fmtHeight(heightPts[0].value)}. ${getLang() === 'nl' ? 'Voeg nog een meting toe om de trend te zien.' : 'Add another measurement to see the trend.'}`));
  } else {
    view.append(el('div', { class: 'muted-box' }, 'Log its height over time to watch it grow.'));
  }
  view.append(el('button', { class: 'btn btn-secondary full', onClick: () => openGrowthDialog(plant) }, '📏 Add measurement'));

  // History timeline
  view.append(el('h2', { class: 'section-title' }, 'Care history'));
  if (events.length === 0) {
    view.append(el('div', { class: 'muted-box' }, 'No history yet. Log a watering or note to start the timeline.'));
  } else {
    const tl = el('div', { class: 'timeline' });
    events.forEach((e) => tl.append(timelineRow(e, plant, () => render())));
    view.append(tl);
  }

  // Danger zone
  view.append(el('div', { class: 'danger-zone' }, [
    el('button', { class: 'text-danger', onClick: () => confirmDelete(plant) }, '🗑️ Delete this plant'),
  ]));

  app.append(view);
});

// Compact "when is it due" label, shared by the plant grid and schedule cards.
// Leans on the surrounding icon for context, so it's just the timing — no verb,
// which keeps the Dutch natural ("Over 3 dagen" rather than "Water over 3 dagen").
// Returns the final localized string directly (not via the DOM pass), because the
// grid concatenates it with an emoji into one text node that localizeDOM can't match.
function scheduleWhenText(daysUntil, paused = false) {
  const nl = getLang() === 'nl';
  if (paused) return nl ? 'Dit seizoen gepauzeerd' : 'Paused this season';
  if (daysUntil < 0) {
    const n = -daysUntil;
    return nl ? `${n} dag${n === 1 ? '' : 'en'} te laat` : `${n} days overdue`;
  }
  if (daysUntil === 0) return nl ? 'Vandaag aan de beurt' : 'Due today';
  const rel = fmtRelative(daysUntil);
  return nl ? rel.charAt(0).toUpperCase() + rel.slice(1) : `Due ${rel}`;
}

function scheduleCard({ icon, title, every, last, due, daysUntil, state, paused, onDo, onDoDated, doLabel, foot }) {
  const cls = STATE_CLASS[state] || 'muted';
  const whenText = scheduleWhenText(daysUntil, paused);
  return el('div', { class: `sched-card sched-${cls}` }, [
    el('div', { class: 'sched-head' }, [
      el('span', { class: 'sched-icon' }, icon),
      el('span', { class: 'sched-title' }, title),
      el('span', { class: `sched-when when-${cls}` }, whenText),
    ]),
    el('div', { class: 'sched-sub' }, `${every} · last: ${last}`),
    foot ? el('div', { class: 'sched-foot' }, foot) : null,
    el('div', { class: 'sched-actions' }, [
      el('button', { class: 'sched-do', onClick: onDo }, doLabel),
      onDoDated ? el('button', { class: 'sched-date-btn', title: 'Log on a specific date', onClick: onDoDated }, '📅') : null,
    ].filter(Boolean)),
  ]);
}

// Log a watering/feeding on a chosen date (default today) — for when you forgot
// to log on the day. Keeping the real date keeps the schedule accurate.
function openLogDialog(plant, type) {
  const isWater = type === 'water';
  const dateInput = el('input', { type: 'date', value: todayISO(), max: todayISO(), class: 'field' });
  const feed = getSettings().feed;
  const feedNote = (!isWater && feed && feed.name)
    ? el('div', { class: 'tips-box small' }, `🧪 Feed with ${feed.name}${feed.npk ? ` (${feed.npk})` : ''}.${feed.dilute ? ' Use about half strength for foliage plants to avoid over-feeding.' : ''}`)
    : null;
  const waterNote = isWater
    ? el('div', { class: 'tips-box small' }, `💧 ${wateringAmount(plant).text}`)
    : null;
  const m = modal([
    el('h3', { class: 'modal-title' }, isWater ? 'Log watering' : 'Log feeding'),
    feedNote,
    waterNote,
    labeled(`When did you ${isWater ? 'water' : 'feed'} it?`, dateInput),
    el('div', { class: 'hint' }, 'Pick the day it actually happened so your schedule stays accurate.'),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onClick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onClick: async () => {
        await logCare(plant.id, type, dateInput.value);
        m.close(); toast(isWater ? 'Watering logged' : 'Feeding logged'); render();
      } }, 'Log'),
    ]),
  ]);
}

// Edit the date of an existing log entry.
function openEditDateDialog(event) {
  const meta = EVENT_META[event.type] || { label: event.type };
  const dateInput = el('input', { type: 'date', value: toDateInputValue(event.date), max: todayISO(), class: 'field' });
  const m = modal([
    el('h3', { class: 'modal-title' }, `Edit date — ${meta.label}`),
    labeled('Date', dateInput),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onClick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onClick: async () => {
        event.date = dateInputToISO(dateInput.value);
        await db.putEvent(event);
        m.close(); toast('Date updated'); render();
      } }, 'Save'),
    ]),
  ]);
}

function careItem(icon, label, value) {
  return el('div', { class: 'care-item' }, [
    el('div', { class: 'care-icon' }, icon),
    el('div', {}, [
      el('div', { class: 'care-label' }, label),
      el('div', { class: 'care-value' }, value),
    ]),
  ]);
}

function quickBtn(icon, label, onClick) {
  return el('button', { class: 'quick-btn', onClick }, [
    el('span', { class: 'quick-icon' }, icon),
    el('span', { class: 'quick-label' }, label),
  ]);
}

async function quickLog(plantId, type) {
  await logCare(plantId, type);
  toast(type === 'water' ? 'Watering logged' : 'Feeding logged');
  render();
}

const EVENT_META = {
  water: { icon: '💧', label: 'Watered' },
  fertilize: { icon: '🌱', label: 'Fed' },
  health: { icon: '❤️', label: 'Health check' },
  photo: { icon: '📷', label: 'Photo' },
  repot: { icon: '🪴', label: 'Repotted' },
  prune: { icon: '✂️', label: 'Pruned' },
  mist: { icon: '💦', label: 'Misted' },
  note: { icon: '📝', label: 'Note' },
  growth: { icon: '📏', label: 'Measured' },
};

function timelineRow(e, plant, onChange) {
  const meta = EVENT_META[e.type] || { icon: '•', label: e.type };
  const healthTag = e.health ? el('span', { class: `health-tag health-${e.health}` }, cap(e.health)) : null;
  return el('div', { class: 'tl-row' }, [
    el('div', { class: 'tl-icon' }, meta.icon),
    el('div', { class: 'tl-body' }, [
      el('div', { class: 'tl-top' }, [
        el('span', { class: 'tl-label' }, meta.label),
        healthTag,
        el('button', { class: 'tl-date tl-date-btn', title: 'Edit date', onClick: () => openEditDateDialog(e) }, fmtDate(e.date)),
      ]),
      e.notes ? el('div', { class: 'tl-notes' }, e.notes) : null,
      e.photo ? el('img', { class: 'tl-photo', src: e.photo, alt: 'photo', onClick: () => openImage(e.photo, fmtDate(e.date)) }) : null,
    ]),
    el('button', {
      class: 'tl-del', title: 'Delete entry',
      onClick: async () => { await db.deleteEvent(e.id); toast('Entry removed'); onChange(); },
    }, '×'),
  ]);
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

// Localized difficulty label. The bare value ('easy'/'moderate'/'hard') is shown
// on its own in a few spots where the DOM dictionary can't reach it, so translate
// it at the source.
function difficultyLabel(d) {
  const nl = getLang() === 'nl'
    ? { easy: 'Makkelijk', moderate: 'Gemiddeld', hard: 'Lastig' }
    : null;
  return (nl && nl[d]) || cap(d);
}

// =========================================================================
// DIALOGS (health, photo, more, image viewer, confirm)
// =========================================================================

function modal(contentNodes, { onClose } = {}) {
  const overlay = el('div', { class: 'modal-overlay', onClick: (e) => { if (e.target === overlay) close(); } });
  const box = el('div', { class: 'modal' }, contentNodes);
  overlay.append(box);
  document.body.append(overlay);
  localizeDOM(overlay); // dialogs live outside #app — translate them too
  function close() { overlay.remove(); if (onClose) onClose(); }
  return { close, overlay };
}

// A full-screen pop-up that stays until the user taps anywhere to dismiss it.
// Used for the playful unit-switch message so it can actually be read. The
// message is already in the right language; data-noloc keeps the DOM pass off it.
function showTapPopup(message) {
  const hint = getLang() === 'nl' ? 'Tik ergens om verder te gaan' : 'Tap anywhere to continue';
  const overlay = el('div', { class: 'tap-popup-overlay', 'data-noloc': '' }, [
    el('div', { class: 'tap-popup' }, [
      el('div', { class: 'tap-popup-msg' }, message),
      el('div', { class: 'tap-popup-hint' }, hint),
    ]),
  ]);
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = () => close();
  overlay.addEventListener('click', close);       // tap anywhere (bubbles from the box)
  document.addEventListener('keydown', onKey);     // or any key, on desktop
  document.body.append(overlay);
  return { close };
}

function openImage(src, caption) {
  const nodes = [
    el('img', { class: 'modal-full-img', src, alt: caption || '' }),
    caption ? el('div', { class: 'modal-caption' }, caption) : null,
  ].filter(Boolean);
  const m = modal(nodes);
  m.overlay.querySelector('.modal').append(
    el('button', { class: 'btn btn-ghost full', onClick: () => m.close() }, 'Close'),
  );
}

function openHealthDialog(plant) {
  let health = 'good';
  const photoState = { dataUrl: null };
  const dateInput = el('input', { type: 'date', value: todayISO(), class: 'field' });
  const notes = el('textarea', { class: 'field', rows: 3, placeholder: 'How is it doing? New growth, spots, drooping…' });

  const chips = el('div', { class: 'seg' }, [
    segChip('good', 'Thriving', () => (health = 'good')),
    segChip('ok', 'So-so', () => (health = 'ok')),
    segChip('poor', 'Struggling', () => (health = 'poor')),
  ]);
  // default select first
  chips.firstChild.classList.add('sel');
  chips.querySelectorAll('.seg-chip').forEach((c) => c.addEventListener('click', () => {
    chips.querySelectorAll('.seg-chip').forEach((x) => x.classList.remove('sel'));
    c.classList.add('sel');
  }));

  const photoBtn = photoPicker(photoState);

  const m = modal([
    el('h3', { class: 'modal-title' }, 'Log health check'),
    labeled('Condition', chips),
    labeled('Date', dateInput),
    labeled('Notes', notes),
    labeled('Photo (optional)', photoBtn.node),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onClick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onClick: async () => {
        await logCare(plant.id, 'health', dateInput.value, {
          health, notes: notes.value.trim(), photo: photoState.dataUrl || undefined,
        });
        m.close(); toast('Health check logged'); render();
      } }, 'Save'),
    ]),
  ]);
}

function openPhotoDialog(plant) {
  const photoState = { dataUrl: null };
  const dateInput = el('input', { type: 'date', value: todayISO(), class: 'field' });
  const notes = el('input', { class: 'field', placeholder: 'Caption (optional)' });
  const photoBtn = photoPicker(photoState, true);
  const setMain = el('input', { type: 'checkbox' });

  const m = modal([
    el('h3', { class: 'modal-title' }, 'Add photo'),
    photoBtn.node,
    labeled('Date', dateInput),
    labeled('Caption', notes),
    el('label', { class: 'checkline' }, [setMain, ' Use as this plant’s main photo']),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onClick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onClick: async () => {
        if (!photoState.dataUrl) { toast('Pick a photo first'); return; }
        await logCare(plant.id, 'photo', dateInput.value, { notes: notes.value.trim(), photo: photoState.dataUrl });
        if (setMain.checked) { plant.photo = photoState.dataUrl; await db.putPlant(plant); }
        m.close(); toast('Photo added'); render();
      } }, 'Save'),
    ]),
  ]);
}

function openMoreDialog(plant, presetType) {
  const dateInput = el('input', { type: 'date', value: todayISO(), max: todayISO(), class: 'field' });
  const notes = el('input', { class: 'field', placeholder: 'Optional note' });
  let type = presetType || 'repot';
  const sel = el('select', { class: 'field', onChange: (e) => (type = e.target.value) }, [
    el('option', { value: 'repot' }, 'Repotted'),
    el('option', { value: 'prune' }, 'Pruned'),
    el('option', { value: 'mist' }, 'Misted'),
    el('option', { value: 'note' }, 'General note'),
  ]);
  sel.value = type;
  const m = modal([
    el('h3', { class: 'modal-title' }, 'Log activity'),
    labeled('Activity', sel),
    labeled('Date', dateInput),
    labeled('Note', notes),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onClick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onClick: async () => {
        await logCare(plant.id, type, dateInput.value, { notes: notes.value.trim() });
        m.close(); toast('Logged'); render();
      } }, 'Save'),
    ]),
  ]);
}

const CONDITION_LEVEL = { good: 'good', ok: 'watch', poor: 'poor' };

// The plant's "chart" for the AI health check: everything the app already knows
// that changes a diagnosis — most importantly when it was actually last watered
// (drooping right after a watering ≠ drooping at day 12) and the pot/drainage.
// Always in English; the AI localizes its *reply* per the system prompt.
function careRecordLines(plant, events, settings, now = new Date()) {
  const lines = [];
  const ago = (d) => {
    const n = Math.max(0, Math.round((now - new Date(d)) / MS_PER_DAY));
    return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
  };

  const lastW = lastEvent(events, plant.id, 'water');
  lines.push(lastW ? `Last watered: ${ago(lastW.date)}` : 'Last watered: never logged');
  if (plant.profile.fertilize) {
    const lastF = lastEvent(events, plant.id, 'fertilize');
    lines.push(lastF ? `Last fed: ${ago(lastF.date)}` : 'Last fed: never logged');
  }
  const eff = effectiveWaterInterval(plant.profile, now, settings.hemisphere, plant.conditions);
  lines.push(`Effective watering interval right now (baseline adjusted for season and pot): every ${eff} days`);

  const cond = conditionsSummary(plant.conditions);
  if (cond) lines.push(`Pot & spot: ${cond}`);
  if (plant.location) lines.push(`Location in home: ${plant.location}`);

  const lastR = lastEvent(events, plant.id, 'repot');
  if (lastR) lines.push(`Last repotted: ${ago(lastR.date)}`);
  const lastP = lastEvent(events, plant.id, 'prune');
  if (lastP) lines.push(`Last pruned: ${ago(lastP.date)}`);

  // Up to 3 most recent health notes (getEvents returns newest first).
  const healths = events.filter((e) => e.type === 'health').slice(0, 3);
  for (const h of healths) {
    const parts = [h.health ? `condition ${h.health}` : null, h.notes || null].filter(Boolean).join(' — ');
    if (parts) lines.push(`Health note (${ago(h.date)}): ${parts}`);
  }

  // Growth trend from logged measurements (stored canonically in cm).
  const growth = events.filter((e) => e.type === 'growth' && Number.isFinite(e.height));
  if (growth.length) {
    const latest = growth[0];
    let g = `Latest height: ${Math.round(latest.height)} cm`;
    const oldest = growth[growth.length - 1];
    if (growth.length > 1 && Math.round(oldest.height) !== Math.round(latest.height)) {
      const diff = Math.round(latest.height - oldest.height);
      g += ` (${diff > 0 ? '+' : ''}${diff} cm since ${ago(oldest.date)})`;
    }
    lines.push(g);
  }
  return lines;
}

async function openAIDialog(plant) {
  const settings = getSettings();

  // No key yet → friendly gate rather than a broken feature.
  if (!hasApiKey()) {
    const m = modal([
      el('h3', { class: 'modal-title' }, '✨ AI health check'),
      el('p', { class: 'modal-text' }, 'Show Claude a photo of your plant and get a warm, expert read on its health plus what to do next.'),
      el('p', { class: 'modal-text' }, 'This is the one feature that needs the internet — it uses your own Anthropic API key, which you add once in Settings and which stays on this device.'),
      el('div', { class: 'modal-actions' }, [
        el('button', { class: 'btn btn-ghost', onClick: () => m.close() }, 'Not now'),
        el('button', { class: 'btn btn-primary', onClick: () => { m.close(); navigate('/settings'); } }, 'Add API key'),
      ]),
    ]);
    return;
  }

  // Events power both the default photo and the care records sent to the AI.
  let events = [];
  try { events = await db.getEvents(plant.id); } catch { /* ignore */ }

  // Default to the most recent photo we have for this plant.
  let defaultPhoto = plant.photo || null;
  const lastPhoto = events.find((e) => e.photo);
  if (lastPhoto) defaultPhoto = lastPhoto.photo;

  const photoState = { dataUrl: defaultPhoto };
  const result = el('div', { class: 'ai-result' });
  const pf = photoField({
    initial: defaultPhoto,
    big: true,
    placeholder: '📷 Take or choose a photo of your plant',
    onPicked: (d) => { photoState.dataUrl = d; result.replaceChildren(); },
  });
  const bgInput = el('textarea', {
    class: 'field', rows: 2,
    placeholder: 'e.g. just repotted it, moved it to a darker room, leaves started browning last week, I water it weekly…',
  });
  const analyzeBtn = el('button', { class: 'btn btn-primary full' }, '✨ Analyze this plant');

  analyzeBtn.addEventListener('click', async () => {
    if (!photoState.dataUrl) { toast('Pick a photo first'); return; }
    analyzeBtn.disabled = true;
    clear(result);
    result.append(el('div', { class: 'ai-loading' }, [
      el('span', { class: 'spinner' }),
      el('span', {}, 'Looking at your plant…'),
    ]));
    try {
      const season = seasonForDate(new Date(), settings.hemisphere);
      const analysis = await analyzePlant(photoState.dataUrl, {
        plantName: plant.name,
        speciesName: speciesLabel(plant),
        season,
        waterBase: plant.profile.water,
        feedBase: plant.profile.fertilize,
        record: careRecordLines(plant, events, settings),
        background: bgInput.value.trim(),
      });
      renderAIResult(result, analysis, plant, photoState.dataUrl, () => m.close());
      analyzeBtn.textContent = '✨ Analyze again';
    } catch (e) {
      clear(result);
      const msg = e instanceof AIError ? e.message : 'Something went wrong. Please try again.';
      result.append(el('div', { class: 'ai-error' }, ['⚠️ ', msg]));
      if (e instanceof AIError && (e.code === 'no-key' || e.code === 'auth')) {
        result.append(el('button', { class: 'btn btn-secondary full', onClick: () => { m.close(); navigate('/settings'); } }, 'Open Settings'));
      }
    } finally {
      analyzeBtn.disabled = false;
    }
  });

  const m = modal([
    el('h3', { class: 'modal-title' }, '✨ AI health check'),
    pf.node,
    labeled('Anything I should know? (optional)', bgInput),
    el('div', { class: 'hint bg-hint' }, 'The more context you give — recent changes, symptoms, how you water it — the better the read. You can add more and tap “Analyze again”.'),
    analyzeBtn,
    result,
    el('button', { class: 'btn btn-ghost full', onClick: () => m.close() }, 'Close'),
  ]);
}

function renderAIResult(container, a, plant, photo, closeDialog) {
  clear(container);
  const level = CONDITION_LEVEL[a.condition] || 'watch';

  if (a.is_plant === false) {
    container.append(el('div', { class: 'ai-bubble' }, [
      el('div', { class: 'ai-headline' }, "Hmm, that doesn't look like a plant"),
      el('div', { class: 'ai-assessment' }, a.assessment || 'Try a photo of just the plant and I’ll take another look.'),
    ]));
    return;
  }

  const bubble = el('div', { class: 'ai-bubble' }, [
    el('div', { class: 'ai-bubble-top' }, [
      statusPill(level, cap(a.condition)),
      a.species_guess ? el('span', { class: 'ai-species' }, `looks like ${a.species_guess}`) : null,
    ]),
    el('div', { class: 'ai-headline' }, a.headline || ''),
    el('div', { class: 'ai-assessment' }, a.assessment || ''),
  ]);

  if (a.observations && a.observations.length) {
    bubble.append(el('div', { class: 'ai-sub' }, 'What I notice'));
    bubble.append(el('ul', { class: 'ai-list' }, a.observations.map((o) => el('li', {}, o))));
  }
  if (a.next_steps && a.next_steps.length) {
    bubble.append(el('div', { class: 'ai-sub' }, 'What to do'));
    bubble.append(el('ol', { class: 'ai-list ai-steps' }, a.next_steps.map((s) => el('li', {}, s))));
  }
  if (a.watch_for && a.watch_for.length) {
    bubble.append(el('div', { class: 'ai-sub' }, 'Keep an eye out for'));
    bubble.append(el('ul', { class: 'ai-list' }, a.watch_for.map((w) => el('li', {}, w))));
  }
  container.append(bubble);

  // One-tap apply: turn the AI's recommendation into concrete schedule changes.
  // Bounds mirror the edit form (water 1–120, feed 0–180) so a hallucinated
  // extreme value can never reach the schedule, even through the preview.
  const adj = a.adjustments || {};
  const changes = [];
  if (adj.recommend_watering_change && Number.isInteger(adj.water_interval_days) &&
      adj.water_interval_days >= 1 && adj.water_interval_days <= 120 &&
      adj.water_interval_days !== plant.profile.water) {
    changes.push({ kind: 'water', from: plant.profile.water, to: adj.water_interval_days });
  }
  if (adj.recommend_feeding_change && Number.isInteger(adj.fertilize_interval_days) &&
      adj.fertilize_interval_days >= 0 && adj.fertilize_interval_days <= 180 &&
      adj.fertilize_interval_days !== plant.profile.fertilize) {
    changes.push({ kind: 'feed', from: plant.profile.fertilize, to: adj.fertilize_interval_days });
  }
  if (adj.water_now) changes.push({ kind: 'water_now' });

  if (changes.length) {
    const label = (c) =>
      c.kind === 'water' ? `💧 Water every ${c.to} day${c.to === 1 ? '' : 's'} (was ${c.from})`
      : c.kind === 'feed' ? (c.to ? `🌱 Feed every ${c.to} days (was ${c.from || 'never'})` : '🌱 Stop scheduled feeding')
      : '💧 Log a watering today';
    const applyCard = el('div', { class: 'apply-card' }, [
      el('div', { class: 'apply-head' }, '✨ Suggested changes'),
      adj.summary ? el('div', { class: 'apply-summary' }, adj.summary) : null,
      el('ul', { class: 'apply-list' }, changes.map((c) => el('li', {}, label(c)))),
    ].filter(Boolean));
    const applyBtn = el('button', { class: 'btn btn-primary full', onClick: async () => {
      applyBtn.disabled = true;
      let profileChanged = false;
      for (const c of changes) {
        if (c.kind === 'water') { plant.profile.water = c.to; profileChanged = true; }
        else if (c.kind === 'feed') { plant.profile.fertilize = c.to; profileChanged = true; }
      }
      if (profileChanged) await db.putPlant(plant);
      if (changes.some((c) => c.kind === 'water_now')) await logCare(plant.id, 'water');
      toast('Applied — schedule updated');
      closeDialog();
      render();
    } }, 'Apply changes');
    applyCard.append(applyBtn);
    container.append(applyCard);
  }

  // Save the read into the plant's health history.
  container.append(el('button', { class: 'btn btn-secondary full', onClick: async () => {
    const notes = [a.headline, a.assessment].filter(Boolean).join(' — ');
    await logCare(plant.id, 'health', todayISO(), { health: a.condition, notes, photo });
    if (a.species_guess && !plant.latin) { plant.latin = a.species_guess; await db.putPlant(plant); }
    toast('Saved to health log');
    closeDialog();
    render();
  } }, '💾 Save this to the health log'));

  // Continue the conversation for free in your own Claude/ChatGPT.
  container.append(el('button', { class: 'btn btn-ghost full', onClick: () => { closeDialog(); openHandoffDialog(plant, a); } }, '💬 Continue this in your own AI'));
}

// Hand off everything about a plant to the user's own Claude/ChatGPT, and import
// findings back — a zero-API-cost way to keep the conversation going.
async function openHandoffDialog(plant, analysis = null) {
  const settings = getSettings();
  const events = await db.getEvents(plant.id);
  const text = buildHandoff({ plant, events, settings, analysis });

  const photoDataUrl = plant.photo || (events.find((e) => e.photo) || {}).photo || null;

  const exportArea = el('textarea', { class: 'field handoff-text', rows: 7, readonly: 'readonly', spellcheck: 'false' });
  exportArea.value = text;
  const copyBtn = el('button', { class: 'btn btn-primary full', onClick: async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied — paste it into Claude or ChatGPT');
    } catch {
      exportArea.focus(); exportArea.select();
      toast('Select all, then copy (Ctrl/Cmd+C)');
    }
  } }, '📋 Copy hand-off');

  // Optional: copy the plant photo too, so the AI can see it.
  let photoRow = null;
  if (photoDataUrl) {
    photoRow = el('div', { class: 'handoff-photo' }, [
      el('img', { src: photoDataUrl, alt: 'plant photo' }),
      el('div', { class: 'handoff-photo-side' }, [
        el('button', { class: 'btn btn-secondary full', onClick: async () => {
          try {
            const blob = await dataUrlToPngBlob(photoDataUrl);
            if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write) {
              await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
              toast('Photo copied — paste it into your AI');
              return;
            }
            if (navigator.canShare) {
              const file = new File([blob], 'plant.png', { type: 'image/png' });
              if (navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); return; }
            }
            throw new Error('unsupported');
          } catch {
            toast('Press and hold the photo to copy it');
          }
        } }, '📷 Copy photo'),
        el('div', { class: 'hint' }, 'Paste the text into your AI, then paste the photo as your next message so it can see the plant.'),
      ]),
    ]);
  }

  const summaryPromptBtn = el('button', { class: 'btn btn-secondary full', onClick: async () => {
    try { await navigator.clipboard.writeText(summaryPrompt(getLang())); toast('Copied — send this to your AI to get the summary'); }
    catch { toast('Copy failed — long-press to copy the prompt below'); }
  } }, '📋 Copy summary prompt');

  const importArea = el('textarea', { class: 'field', rows: 5, placeholder: 'Paste your AI’s summary block here…' });
  const importResult = el('div', { class: 'ai-result' });
  const reviewBtn = el('button', { class: 'btn btn-secondary full', onClick: () => {
    clear(importResult);
    const parsed = parseHandoffImport(importArea.value);
    if (!parsed) {
      importResult.append(el('div', { class: 'ai-error' }, '⚠️ Couldn’t find a structured summary in that reply. Use “Copy summary prompt” above, send it to your AI, then paste what it gives back.'));
      return;
    }
    renderImportPreview(importResult, parsed, plant, () => m.close());
  } }, 'Review findings');

  const children = [
    el('h3', { class: 'modal-title' }, '💬 Continue in your own AI'),
    el('div', { class: 'hint' }, 'Paste this hand-off into Claude or ChatGPT to keep troubleshooting for free — it includes everything about this plant. When you’re done, paste the reply back below to import any changes.'),
    el('div', { class: 'handoff-step' }, '1 · Copy & paste into your AI'),
    exportArea,
    copyBtn,
    photoRow,
    el('div', { class: 'handoff-step' }, '2 · Bring the findings back'),
    el('div', { class: 'hint' }, 'When you’re done chatting, ask your AI for an importable summary — copy this prompt, send it, then paste back whatever it replies:'),
    summaryPromptBtn,
    importArea,
    reviewBtn,
    importResult,
    el('button', { class: 'btn btn-ghost full', onClick: () => m.close() }, 'Close'),
  ].filter(Boolean);
  const m = modal(children);
}

function renderImportPreview(container, parsed, plant, closeDialog) {
  clear(container);
  const level = CONDITION_LEVEL[parsed.condition] || 'watch';
  const bubble = el('div', { class: 'ai-bubble' }, [
    parsed.condition ? el('div', { class: 'ai-bubble-top' }, [statusPill(level, cap(parsed.condition))]) : null,
    parsed.summary ? el('div', { class: 'ai-headline' }, parsed.summary) : null,
    parsed.assessment ? el('div', { class: 'ai-assessment' }, parsed.assessment) : null,
  ].filter(Boolean));
  if (parsed.next_steps.length) {
    bubble.append(el('div', { class: 'ai-sub' }, 'Next steps'));
    bubble.append(el('ol', { class: 'ai-list ai-steps' }, parsed.next_steps.map((sp) => el('li', {}, sp))));
  }
  container.append(bubble);

  const cc = parsed.care_changes;
  const changes = [];
  // Same bounds as the edit form (water 1–120, feed 0–180) — pasted AI output
  // is even less trustworthy than our own API path.
  if (Number.isInteger(cc.water_interval_days) && cc.water_interval_days >= 1 && cc.water_interval_days <= 120 && cc.water_interval_days !== plant.profile.water) {
    changes.push({ kind: 'water', to: cc.water_interval_days, from: plant.profile.water });
  }
  if (Number.isInteger(cc.fertilize_interval_days) && cc.fertilize_interval_days >= 0 && cc.fertilize_interval_days <= 180 && cc.fertilize_interval_days !== plant.profile.fertilize) {
    changes.push({ kind: 'feed', to: cc.fertilize_interval_days, from: plant.profile.fertilize });
  }
  if (cc.light && cc.light !== plant.profile.light) {
    changes.push({ kind: 'light', to: cc.light, from: plant.profile.light });
  }

  if (changes.length) {
    const label = (c) =>
      c.kind === 'water' ? `💧 Water every ${c.to} day${c.to === 1 ? '' : 's'} (was ${c.from})`
      : c.kind === 'feed' ? (c.to ? `🌱 Feed every ${c.to} days (was ${c.from || 'never'})` : '🌱 Stop scheduled feeding')
      : `☀️ Light: ${LIGHT[c.to] || c.to}`;
    container.append(el('div', { class: 'apply-card' }, [
      el('div', { class: 'apply-head' }, '✨ Changes from your conversation'),
      cc.reason ? el('div', { class: 'apply-summary' }, cc.reason) : null,
      el('ul', { class: 'apply-list' }, changes.map((c) => el('li', {}, label(c)))),
    ].filter(Boolean)));
  }

  const applyBtn = el('button', { class: 'btn btn-primary full', onClick: async () => {
    applyBtn.disabled = true;
    let profileChanged = false;
    for (const c of changes) {
      if (c.kind === 'water') { plant.profile.water = c.to; profileChanged = true; }
      else if (c.kind === 'feed') { plant.profile.fertilize = c.to; profileChanged = true; }
      else if (c.kind === 'light') { plant.profile.light = c.to; profileChanged = true; }
    }
    if (profileChanged) await db.putPlant(plant);
    const notes = [parsed.summary, parsed.assessment, parsed.log_note].filter(Boolean).join(' — ') || 'Imported from my AI conversation';
    await logCare(plant.id, 'health', todayISO(), { health: parsed.condition || undefined, notes });
    toast(changes.length ? 'Imported — schedule updated & saved to log' : 'Imported to health log');
    closeDialog();
    render();
  } }, changes.length ? 'Apply & save to log' : 'Save to health log');
  container.append(applyBtn);
}

// Reusable photo input with BOTH a "Take photo" (opens the camera on phones via
// the `capture` hint) and a "Choose" (file library) option, plus a live preview.
// onPicked(dataUrl) fires with a resized JPEG data URL when a photo is selected.
function photoField({ initial = null, big = true, placeholder = '📷 Take or choose a photo', onPicked } = {}) {
  const preview = el('div', { class: big ? 'photo-preview big' : 'photo-preview' },
    initial ? [el('img', { src: initial, alt: 'preview' })] : placeholder);

  function setPhoto(dataUrl) {
    clear(preview);
    preview.append(el('img', { src: dataUrl, alt: 'preview' }));
    if (onPicked) onPicked(dataUrl);
  }
  async function handle(file) {
    if (!file) return;
    try { setPhoto(await fileToResizedDataURL(file)); }
    catch { toast('Could not load that image'); }
  }

  // capture="environment" nudges phones to open the rear camera directly.
  const takeInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden-file' });
  takeInput.addEventListener('change', () => handle(takeInput.files[0]));
  const chooseInput = el('input', { type: 'file', accept: 'image/*', class: 'hidden-file' });
  chooseInput.addEventListener('change', () => handle(chooseInput.files[0]));

  // In the native app the WebView's <input capture> opens the gallery, not the
  // camera — so route "Take photo" through the native Camera plugin instead.
  const takeAction = native.isNative
    ? el('button', { type: 'button', class: 'photo-action', onClick: async () => {
        const dataUrl = await native.takePhoto();
        if (dataUrl) setPhoto(dataUrl);
      } }, '📷 Take photo')
    : el('label', { class: 'photo-action' }, ['📷 Take photo', takeInput]);

  const node = el('div', { class: 'photo-field' }, [
    el('label', { class: 'photo-preview-wrap' }, [preview, chooseInput]),
    el('div', { class: 'photo-actions' }, [
      takeAction,
      el('label', { class: 'photo-action' }, ['🖼️ Choose', el('input', { type: 'file', accept: 'image/*', class: 'hidden-file',
        onChange: (e) => handle(e.target.files[0]) })]),
    ]),
  ]);
  return { node, preview };
}

function photoPicker(state, big = false) {
  const { node } = photoField({ initial: state.dataUrl || null, big, onPicked: (d) => { state.dataUrl = d; } });
  return { node };
}

// Log a growth measurement (height and/or leaf count).
function openGrowthDialog(plant) {
  const dateInput = el('input', { type: 'date', value: todayISO(), max: todayISO(), class: 'field' });
  const heightInput = el('input', { type: 'number', min: '0', step: '0.5', class: 'field', placeholder: 'e.g. 24', inputmode: 'decimal' });
  const leavesInput = el('input', { type: 'number', min: '0', step: '1', class: 'field', placeholder: 'optional', inputmode: 'numeric' });
  const notes = el('input', { class: 'field', placeholder: 'Optional note (new leaf, flower bud…)' });
  const m = modal([
    el('h3', { class: 'modal-title' }, 'Log a measurement'),
    labeled('Date', dateInput),
    labeled(`Height (${heightUnit()})`, heightInput),
    labeled('Leaf count', leavesInput),
    labeled('Note', notes),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onClick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onClick: async () => {
        // Store height canonically in cm; the input is in the chosen unit.
        const height = heightInput.value !== '' ? heightToCm(heightInput.value) : null;
        const leaves = leavesInput.value !== '' ? +leavesInput.value : null;
        if (height == null && leaves == null && !notes.value.trim()) { toast('Enter a height or leaf count'); return; }
        const bits = [];
        if (height != null) bits.push(fmtHeight(height));
        if (leaves != null) bits.push(`${leaves} leaves`);
        const noteStr = [bits.join(' · '), notes.value.trim()].filter(Boolean).join(' — ');
        await logCare(plant.id, 'growth', dateInput.value, {
          height: height != null ? height : undefined,
          leaves: leaves != null ? leaves : undefined,
          notes: noteStr,
        });
        m.close(); toast('Measurement logged'); render();
      } }, 'Save'),
    ]),
  ]);
}

// Minimal SVG line chart of numeric points over time.
function growthChart(points) {
  const W = 320, H = 120, pad = 14;
  const xs = points.map((p) => p.date.getTime());
  const ys = points.map((p) => p.value);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = (maxX - minX) || 1;
  const spanY = (maxY - minY) || 1;
  const px = (t) => pad + ((t - minX) / spanX) * (W - pad * 2);
  const py = (v) => H - pad - ((v - minY) / spanY) * (H - pad * 2);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${px(p.date.getTime()).toFixed(1)},${py(p.value).toFixed(1)}`).join(' ');
  const dots = points.map((p) => `<circle cx="${px(p.date.getTime()).toFixed(1)}" cy="${py(p.value).toFixed(1)}" r="3" fill="currentColor"/>`).join('');
  const svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>${dots}</svg>`;
  return el('div', { class: 'growth-chart', html: svg });
}

// A one-tap camera button that saves a progress/health photo straight to the
// plant's log (opens the camera directly on phones via `capture`).
function quickPhotoButton(plant, { className = 'btn btn-secondary full', label = '📷 Add progress photo', stopProp = false } = {}) {
  async function savePhoto(dataUrl) {
    try {
      await logCare(plant.id, 'photo', todayISO(), { photo: dataUrl });
      if (!plant.photo) { plant.photo = dataUrl; await db.putPlant(plant); }
      toast('Progress photo added');
      render();
    } catch { toast('Could not save that photo'); }
  }

  // Native: the WebView's <input capture> opens the gallery, so use the native
  // Camera plugin to actually open the camera.
  if (native.isNative) {
    return el('button', { type: 'button', class: className, onClick: async (e) => {
      if (stopProp) e.stopPropagation();
      const dataUrl = await native.takePhoto();
      if (dataUrl) savePhoto(dataUrl);
    } }, label);
  }

  const input = el('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'hidden-file' });
  input.addEventListener('change', async () => {
    const file = input.files[0]; if (!file) return;
    try { savePhoto(await fileToResizedDataURL(file)); }
    catch { toast('Could not save that photo'); }
  });
  const attrs = { class: className };
  if (stopProp) attrs.onClick = (e) => e.stopPropagation();
  return el('label', attrs, [label, input]);
}

function labeled(label, field) {
  return el('label', { class: 'form-row' }, [el('span', { class: 'form-label' }, label), field]);
}

function segChip(value, label, onClick) {
  return el('button', { class: `seg-chip seg-${value}`, type: 'button', dataset: { value }, onClick }, label);
}

function confirmDelete(plant) {
  const m = modal([
    el('h3', { class: 'modal-title' }, `Delete ${plant.name}?`),
    el('p', { class: 'modal-text' }, 'This removes the plant and its entire care history. This cannot be undone.'),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', onClick: () => m.close() }, 'Cancel'),
      el('button', { class: 'btn btn-danger', onClick: async () => {
        await db.deletePlant(plant.id); m.close(); toast('Plant deleted'); navigate('/plants');
      } }, 'Delete'),
    ]),
  ]);
}

// =========================================================================
// ADD / EDIT PLANT
// =========================================================================

route(/^\/add$/, () => plantForm(null));
route(/^\/edit\/(.+)$/, async (id) => {
  const plant = await db.getPlant(id);
  if (!plant) { navigate('/plants'); return; }
  plantForm(plant);
});

function plantForm(existing) {
  const isEdit = !!existing;
  const settings = getSettings();
  const now = new Date();

  const model = existing
    ? JSON.parse(JSON.stringify(existing))
    : {
        id: db.uid('pl'), name: '', speciesId: '', latin: '', location: '', potSize: '',
        acquiredDate: null, photo: null, conditions: {}, profile: { ...DEFAULT_PROFILE }, createdAt: new Date().toISOString(),
      };
  if (!model.conditions) model.conditions = {};

  const view = el('div', { class: 'view' });
  view.append(viewHeader(isEdit ? 'Edit plant' : 'Add plant', { back: isEdit ? `/plant/${model.id}` : '/plants' }));

  const form = el('div', { class: 'form' });

  // Photo — take with the camera or choose from the library.
  const photoState = { dataUrl: model.photo };
  const idNote = el('div', { class: 'id-note' });
  const idBtn = el('button', { class: 'btn btn-secondary full', type: 'button', style: 'display:none' }, '✨ Identify & assess from photo');
  const idPasteBtn = el('button', { class: 'btn btn-ghost full', type: 'button', style: 'display:none' }, '📋 Identify with your own AI (no key)');
  const photoFieldEl = photoField({
    initial: model.photo,
    big: true,
    onPicked: (d) => { photoState.dataUrl = d; idBtn.style.display = ''; idPasteBtn.style.display = ''; clear(idNote); },
  });
  form.append(photoFieldEl.node);

  idBtn.addEventListener('click', async () => {
    if (!photoState.dataUrl) return;
    if (!hasApiKey()) {
      clear(idNote);
      idNote.append('Add your Anthropic API key in Settings to use AI identification.');
      return;
    }
    idBtn.disabled = true; idBtn.textContent = 'Looking…';
    try {
      const a = await analyzePlant(photoState.dataUrl, { season: seasonForDate(now, settings.hemisphere) });
      clear(idNote);
      if (a.is_plant === false) {
        idNote.append("That doesn't look like a plant — try another photo.");
      } else {
        const guess = a.species_guess;
        const match = guess ? findSpeciesByName(guess) : null;
        if (match) {
          // In the library → select it so its full care profile loads.
          speciesSel.value = match.id;
          buildSpeciesOptions(speciesSel, match.id);
          refreshFromSpecies(true);
          idNote.append(el('div', {}, `✅ Identified as ${match.name} — care details loaded. ${a.assessment || ''}`.trim()));
        } else if (guess) {
          // Not in the library → route to the lookup with the name filled in.
          speciesSel.value = '__custom';
          refreshFromSpecies(false); // reveals the custom lookup box
          lookupNameInput.value = guess;
          if (!nameInput.value) nameInput.value = guess;
          idNote.append(el('div', { class: 'id-missing' }, [
            `Looks like ${guess} — but the app has no care info for it yet. `,
            el('b', {}, 'Add it below'),
            ' via the API, or by pasting from your own Claude/ChatGPT.',
          ]));
          customBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
          idNote.append(el('div', {}, `${a.headline || ''} ${a.assessment || ''}`.trim()));
        }
      }
    } catch (e) {
      clear(idNote);
      idNote.append('⚠️ ' + (e instanceof AIError ? e.message : 'Could not analyze that photo.'));
    } finally {
      idBtn.disabled = false; idBtn.textContent = '✨ Identify & assess from photo';
    }
  });
  // Paste-based identification (no API key) — opens the paste dialog with the photo.
  idPasteBtn.addEventListener('click', () => {
    if (!photoState.dataUrl) return;
    openSpeciesPasteDialog('', applyIdentifiedCare, photoState.dataUrl);
  });
  if (isEdit && model.photo) { idBtn.style.display = ''; idPasteBtn.style.display = ''; }
  form.append(idBtn, idPasteBtn, idNote);

  // Name
  const nameInput = el('input', { class: 'field', placeholder: 'e.g. Monstera by the window', value: model.name });
  form.append(labeled('Nickname *', nameInput));

  // Species picker
  const speciesSel = el('select', { class: 'field' });
  buildSpeciesOptions(speciesSel, model.speciesId || (isEdit ? '__custom' : ''));

  const tipBox = el('div', { class: 'tips-box small' });
  function refreshFromSpecies(applyProfile) {
    const id = speciesSel.value;
    if (id && id !== '__custom') {
      const s = getSpecies(id);
      if (applyProfile) {
        model.profile = profileFromSpecies(id);
        model.speciesId = id;
        model.latin = s.latin;
        latinInput.value = s.latin;
        syncAdvancedInputs();
      }
      clear(tipBox); tipBox.append('💡 ', s.tips);
      tipBox.style.display = '';
    } else {
      model.speciesId = '';
      tipBox.style.display = 'none';
    }
    if (customBox) customBox.style.display = (speciesSel.value === '__custom') ? '' : 'none';
  }
  speciesSel.addEventListener('change', () => refreshFromSpecies(true));
  form.append(labeled('Species', speciesSel));
  form.append(tipBox);

  // Not in our library? Look up care details with AI.
  const lookupNameInput = el('input', { class: 'field', placeholder: 'e.g. Bird of Paradise, Strelitzia' });
  const lookupBtn = el('button', { class: 'btn btn-secondary full', type: 'button' }, '✨ Look up care info');
  const pasteSpeciesBtn = el('button', { class: 'btn btn-ghost full', type: 'button' }, '📋 Or paste from your own AI (no key)');
  const lookupNote = el('div', { class: 'id-note' });
  const customBox = el('div', { class: 'custom-box', style: 'display:none' }, [
    el('div', { class: 'hint' }, 'Not in our library? Type the species and get its care details — either via the API, or by pasting from your own Claude/ChatGPT. It’s saved for reuse.'),
    labeled('Species name', lookupNameInput),
    lookupBtn,
    pasteSpeciesBtn,
    lookupNote,
  ]);
  form.append(customBox);

  // Latin / details
  const latinInput = el('input', { class: 'field', placeholder: 'Latin name (optional)', value: model.latin });
  form.append(labeled('Latin name', latinInput));
  const locInput = el('input', { class: 'field', placeholder: 'e.g. Living room, south window', value: model.location });
  form.append(labeled('Location', locInput));
  const acquiredInput = el('input', { type: 'date', class: 'field', value: model.acquiredDate ? toDateInputValue(model.acquiredDate) : todayISO() });
  form.append(labeled('Acquired / potted on', acquiredInput));

  // Last watered — so a plant you've had a while starts with an accurate schedule.
  const lastWateredInput = el('input', { type: 'date', class: 'field', max: todayISO() });
  const lastFedInput = el('input', { type: 'date', class: 'field', max: todayISO() });
  if (!isEdit) {
    form.append(labeled('Last watered (optional)', lastWateredInput));
    form.append(labeled('Last fed (optional)', lastFedInput));
    form.append(el('div', { class: 'hint bg-hint' }, 'Had it a while? Set when you last watered and fed it so both schedules start accurate. Leave blank if it’s brand new.'));
  }

  // Advanced schedule (prefilled from species, editable)
  const adv = el('div', { class: 'advanced' });
  const advToggle = el('button', { class: 'advanced-toggle', type: 'button' }, '⚙️ Watering & feeding schedule');
  const advBody = el('div', { class: 'advanced-body' });

  const waterInput = el('input', { type: 'number', min: '1', max: '120', class: 'field', value: model.profile.water });
  const winterSel = el('select', { class: 'field' }, [
    el('option', { value: '1.2' }, 'Barely (tropicals in warm homes)'),
    el('option', { value: '1.6' }, 'Noticeably less'),
    el('option', { value: '2.0' }, 'Much less (typical succulents)'),
    el('option', { value: '3.0' }, 'Almost stop (cacti, dormant)'),
  ]);
  winterSel.value = nearestWinter(model.profile.winterFactor);
  const feedInput = el('input', { type: 'number', min: '0', max: '180', class: 'field', value: model.profile.fertilize });
  const lightSel = el('select', { class: 'field' }, Object.entries(LIGHT).map(([k, v]) => el('option', { value: k }, v)));
  lightSel.value = model.profile.light;
  // Plant type — drives feed-by-type spacing and the tailored troubleshooter,
  // so even a custom plant added without a lookup gets the full treatment.
  const categorySel = el('select', { class: 'field' }, PLANT_CATEGORIES.map(([v, l]) => el('option', { value: v }, l)));
  categorySel.value = model.profile.category || 'other';

  advBody.append(
    labeled('Water every … days (growing season)', waterInput),
    labeled('Reduce watering in winter', winterSel),
    labeled('Fertilize every … days (0 = rarely)', feedInput),
    labeled('Light preference', lightSel),
    labeled('Plant type (tailors feeding & troubleshooting)', categorySel),
    el('div', { class: 'hint' }, 'These are prefilled from the species and adjust automatically by season. Tweak if your conditions differ.'),
  );
  function syncAdvancedInputs() {
    waterInput.value = model.profile.water;
    winterSel.value = nearestWinter(model.profile.winterFactor);
    feedInput.value = model.profile.fertilize;
    lightSel.value = model.profile.light;
    categorySel.value = model.profile.category || 'other';
  }
  advToggle.addEventListener('click', () => adv.classList.toggle('open'));
  adv.append(advToggle, advBody);
  form.append(adv);
  if (isEdit) adv.classList.add('open');

  // Pot & spot conditions — personalize the watering frequency.
  const condOpt = (cur, opts) => {
    const s = el('select', { class: 'field' });
    s.append(el('option', { value: '' }, '—'));
    for (const [v, l] of opts) s.append(el('option', { value: v }, l));
    s.value = cur || '';
    return s;
  };
  const potSizeSel = condOpt(model.conditions.potSize, [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']]);
  const potMaterialSel = condOpt(model.conditions.potMaterial, [['terracotta', 'Terracotta / clay'], ['plastic', 'Plastic'], ['ceramic', 'Glazed ceramic'], ['metal', 'Metal']]);
  const drainageSel = condOpt(model.conditions.drainage, [['yes', 'Has drainage holes'], ['no', 'No drainage']]);
  const lightSpotSel = condOpt(model.conditions.lightSpot, [['low', 'Low light'], ['medium', 'Medium / bright indirect'], ['bright', 'Bright / direct sun']]);
  const currentConditions = () => ({
    potSize: potSizeSel.value || undefined,
    potMaterial: potMaterialSel.value || undefined,
    drainage: drainageSel.value || undefined,
    lightSpot: lightSpotSel.value || undefined,
  });

  // Live preview of the effective interval (base × season × pot/spot).
  const preview = el('div', { class: 'interval-preview' });
  function refreshPreview() {
    const p = { ...model.profile, water: +waterInput.value || 7, winterFactor: +winterSel.value };
    const eff = effectiveWaterInterval(p, now, settings.hemisphere, currentConditions());
    const season = seasonForDate(now, settings.hemisphere);
    clear(preview);
    preview.append(getLang() === 'nl'
      ? `${SEASON_META[season].emoji} Op dit moment geef je hier ongeveer elke ${eff} dag${eff === 1 ? '' : 'en'} water.`
      : `${SEASON_META[season].emoji} Right now this waters about every ${eff} day${eff === 1 ? '' : 's'}.`);
  }
  [waterInput, winterSel, potSizeSel, potMaterialSel, drainageSel, lightSpotSel].forEach((i) => i.addEventListener('input', refreshPreview));
  form.append(el('div', { class: 'cond-section' }, [
    el('h2', { class: 'section-title' }, 'This plant’s pot & spot'),
    el('div', { class: 'hint bg-hint' }, 'Optional — tailors watering to your actual pot and where it sits (terracotta and small pots dry out faster; low light stays wet longer).'),
    labeled('Pot size', potSizeSel),
    labeled('Pot material', potMaterialSel),
    labeled('Drainage', drainageSel),
    labeled('Light in its spot', lightSpotSel),
    preview,
  ]));
  refreshPreview();

  refreshFromSpecies(false);

  // Gentle safeguard: warn (never block) when the schedule is far from the
  // species' preferences, with a one-tap "use recommended".
  const warnBox = el('div', { class: 'sched-warn' });
  function refreshWarnings() {
    clear(warnBox);
    const sid = (speciesSel.value && speciesSel.value !== '__custom') ? speciesSel.value : '';
    const warns = scheduleWarnings({ water: +waterInput.value || 0, fertilize: +feedInput.value || 0 }, sid);
    for (const w of warns) {
      warnBox.append(el('div', { class: 'warn-row' }, [
        el('div', { class: 'warn-msg' }, ['⚠️ ', w.message]),
        el('button', { class: 'warn-btn', type: 'button', onClick: () => {
          if (w.field === 'water') waterInput.value = w.recommended;
          else feedInput.value = w.recommended;
          refreshWarnings();
          refreshPreview();
        } }, `Use ${w.recommended} days`),
      ]));
    }
  }
  waterInput.addEventListener('input', refreshWarnings);
  feedInput.addEventListener('input', refreshWarnings);
  // Runs after refreshFromSpecies has reset the inputs, so the preview + warnings reflect the new species.
  speciesSel.addEventListener('change', () => setTimeout(() => { refreshWarnings(); refreshPreview(); }, 0));
  form.append(warnBox);
  refreshWarnings();

  // Apply looked-up (API or pasted) care data: fill the form, save to the
  // reusable library, and select the new species. Shared by both lookup paths.
  async function applyLookedUpCare(c) {
    Object.assign(model.profile, {
      water: Math.max(1, c.water_interval_days || model.profile.water),
      winterFactor: c.winter_factor || model.profile.winterFactor,
      fertilize: Math.max(0, Number.isInteger(c.fertilize_interval_days) ? c.fertilize_interval_days : model.profile.fertilize),
      feedWinter: !!c.feed_winter,
      light: c.light || model.profile.light,
      humidity: c.humidity || model.profile.humidity,
      tempMin: Number.isFinite(c.temp_min_c) ? c.temp_min_c : model.profile.tempMin,
      toxic: c.toxicity || model.profile.toxic,
      difficulty: c.difficulty || model.profile.difficulty,
      soil: c.soil || model.profile.soil,
      category: c.category || model.profile.category || 'other',
      tips: c.tips || model.profile.tips,
    });
    if (c.latin_name && !latinInput.value) latinInput.value = c.latin_name;
    if (c.common_name && !nameInput.value) nameInput.value = c.common_name;
    syncAdvancedInputs(); refreshPreview(); refreshWarnings();
    adv.classList.add('open');
    const savedId = await saveLookedUpSpecies(c);
    model.speciesId = savedId;
    buildSpeciesOptions(speciesSel, savedId);
    refreshFromSpecies(false); // show the species tip + hide the custom box
    toast(`Saved ${c.common_name || latinInput.value || 'this species'} to your library`);
  }

  // From a pasted identification: prefer a built-in library match (curated care),
  // otherwise save the pasted data as a custom species.
  async function applyIdentifiedCare(c) {
    const match = findSpeciesByName(c.common_name || c.latin_name);
    if (match && !isCustomSpecies(match.id)) {
      speciesSel.value = match.id;
      buildSpeciesOptions(speciesSel, match.id);
      refreshFromSpecies(true);
      if (c.latin_name && !latinInput.value) latinInput.value = c.latin_name;
      toast(`Identified as ${match.name} — care details loaded`);
    } else {
      await applyLookedUpCare(c);
    }
  }

  // Option A — look up care via the API.
  lookupBtn.addEventListener('click', async () => {
    const q = lookupNameInput.value.trim() || nameInput.value.trim();
    clear(lookupNote);
    if (!q) { lookupNote.append('Type a species name first.'); return; }
    if (!hasApiKey()) { lookupNote.append('Add your Anthropic API key in Settings, or use “paste from your own AI” below.'); return; }
    lookupBtn.disabled = true; lookupBtn.textContent = 'Looking up…';
    try {
      const c = await lookupSpeciesCare(q, photoState.dataUrl || null);
      clear(lookupNote);
      if (!c.matched) lookupNote.append('⚠️ ' + (c.note || 'Couldn’t identify that species — try a more specific name.'));
      else await applyLookedUpCare(c);
    } catch (e) {
      clear(lookupNote);
      lookupNote.append('⚠️ ' + (e instanceof AIError ? e.message : 'Lookup failed. Please try again.'));
    } finally {
      lookupBtn.disabled = false; lookupBtn.textContent = '✨ Look up care info';
    }
  });

  // Option B — paste care from your own Claude/ChatGPT (no API key).
  pasteSpeciesBtn.addEventListener('click', () => {
    openSpeciesPasteDialog(lookupNameInput.value.trim() || nameInput.value.trim(), applyLookedUpCare);
  });

  // Save
  form.append(el('div', { class: 'form-actions' }, [
    el('button', { class: 'btn btn-primary full', onClick: async () => {
      if (!nameInput.value.trim()) { toast('Give your plant a nickname'); nameInput.focus(); return; }
      model.name = nameInput.value.trim();
      model.latin = latinInput.value.trim();
      model.location = locInput.value.trim();
      model.acquiredDate = acquiredInput.value ? dateInputToISO(acquiredInput.value) : null;
      model.photo = photoState.dataUrl || null;
      if (speciesSel.value === '__custom' || !speciesSel.value) model.speciesId = '';
      else model.speciesId = speciesSel.value;
      model.profile.water = Math.max(1, +waterInput.value || 7);
      model.profile.winterFactor = +winterSel.value || 1.5;
      model.profile.fertilize = Math.max(0, +feedInput.value || 0);
      model.profile.light = lightSel.value;
      model.profile.category = categorySel.value || 'other';
      model.conditions = currentConditions();
      await db.putPlant(model);
      // Log the photo you added (often the identification photo) as the starting
      // photo, so it appears in the progression and doesn't nag for one. Dated
      // TODAY — it's a snapshot of the plant now, not when you acquired it.
      if (!isEdit && model.photo) {
        await logCare(model.id, 'photo', todayISO(), { photo: model.photo, notes: 'Starting photo' });
      }
      if (!isEdit && lastWateredInput.value) {
        await logCare(model.id, 'water', lastWateredInput.value);
      }
      if (!isEdit && lastFedInput.value) {
        await logCare(model.id, 'fertilize', lastFedInput.value);
      }
      toast(isEdit ? 'Plant updated' : 'Plant added');
      navigate(`/plant/${model.id}`);
    } }, isEdit ? 'Save changes' : 'Add plant'),
  ]));

  view.append(form);
  app.append(view);
}

function nearestWinter(f) {
  const opts = [1.2, 1.6, 2.0, 3.0];
  let best = opts[0];
  for (const o of opts) if (Math.abs(o - f) < Math.abs(best - f)) best = o;
  return String(best);
}

// =========================================================================
// CARE GUIDE (species library) + DIAGNOSTICS
// =========================================================================

route(/^\/guide$/, () => {
  const view = el('div', { class: 'view' });
  view.append(viewHeader('Care Guide'));

  view.append(el('div', { class: 'guide-tabs' }, [
    el('button', { class: 'guide-tab active' }, 'Plants'),
    el('button', { class: 'guide-tab', onClick: () => navigate('/diagnose') }, 'Troubleshoot'),
  ]));

  const search = el('input', { class: 'field search', placeholder: '🔍 Search plants…' });
  view.append(search);

  const list = el('div', { class: 'guide-list' });
  function draw(filter = '') {
    clear(list);
    const q = filter.toLowerCase();
    allSpecies().filter((s) =>
      s.name.toLowerCase().includes(q) ||
      (s.latin || '').toLowerCase().includes(q) ||
      (s.aka || []).some((a) => a.toLowerCase().includes(q)),
    ).forEach((s) => {
      list.append(el('div', { class: 'guide-row', onClick: () => navigate(`/guide/${s.id}`) }, [
        el('span', { class: 'guide-emoji' }, categoryEmoji(s.category)),
        el('div', { class: 'guide-row-main' }, [
          el('div', { class: 'guide-name' }, s.name),
          el('div', { class: 'guide-latin' }, s.latin),
        ]),
        isCustomSpecies(s.id) ? el('span', { class: 'diff saved-tag' }, 'Saved') : el('span', { class: `diff diff-${s.difficulty}` }, difficultyLabel(s.difficulty)),
      ]));
    });
    if (!list.children.length) list.append(el('div', { class: 'muted-box' }, 'No matches.'));
  }
  search.addEventListener('input', () => draw(search.value));
  draw();
  view.append(list);
  app.append(view);
});

route(/^\/guide\/(.+)$/, (id) => {
  const s = getSpecies(id);
  if (!s) { navigate('/guide'); return; }
  const view = el('div', { class: 'view' });
  view.append(viewHeader(s.name, { back: '/guide' }));
  view.append(el('div', { class: 'guide-hero' }, [
    el('div', { class: 'guide-hero-emoji' }, categoryEmoji(s.category)),
    el('div', {}, [
      el('div', { class: 'guide-hero-latin' }, s.latin),
      (s.aka && s.aka.length) ? el('div', { class: 'guide-aka' }, 'aka ' + s.aka.join(', ')) : null,
      el('span', { class: `diff diff-${s.difficulty}` }, cap(s.difficulty) + ' care'),
    ]),
  ]));
  // Species reference photo — bundled for built-in species (instant, offline);
  // custom species fall back to the shared runtime Wikipedia cache.
  const refSlot = el('div', { class: 'ref-grid guide-ref' });
  view.append(refSlot);
  const bundledRef = SPECIES_PHOTOS[s.id];
  if (bundledRef) {
    refSlot.append(refPhotoCard(bundledRef));
  } else {
    (async () => {
      const img = await getRefPhotoCached(s.latin || s.name, [s.latin, s.name]);
      if (img && refSlot.isConnected) { refSlot.append(refPhotoCard(img)); localizeDOM(refSlot); }
    })();
  }
  view.append(el('div', { class: 'care-grid' }, [
    careItem('☀️', 'Light', LIGHT[s.light] || s.light),
    careItem('💧', 'Water', `Every ${s.water} days (growing season)`),
    careItem('❄️', 'Winter', winterWords(s.winterFactor)),
    careItem('💦', 'Humidity', s.humidity),
    careItem('🌡️', 'Min temp', fmtTemp(s.tempMin)),
    careItem('🌱', 'Feed', s.fertilize ? `Every ${s.fertilize} days in season` : 'Rarely'),
    careItem('🪴', 'Soil', s.soil),
    careItem('🐾', 'Toxicity', s.toxic),
  ]));
  view.append(el('div', { class: 'tips-box' }, ['💡 ', s.tips]));
  view.append(el('div', { class: 'form-actions' }, [
    el('button', { class: 'btn btn-primary full', onClick: () => {
      navigate('/add');
      // preselect after navigation
      setTimeout(() => {
        const sel = document.querySelector('.form select');
        if (sel) { sel.value = s.id; sel.dispatchEvent(new Event('change')); }
      }, 60);
    } }, `＋ Add my ${s.name}`),
  ]));
  if (isCustomSpecies(s.id)) {
    view.append(el('div', { class: 'danger-zone' }, [
      el('button', { class: 'text-danger', onClick: async () => {
        await db.deleteCustomSpecies(s.id);
        await reloadCustomSpecies();
        toast('Removed from your library');
        navigate('/guide');
      } }, '🗑️ Remove from my library'),
    ]));
  }
  app.append(view);
});

function winterWords(f) {
  if (f >= 2.5) return 'Almost stop watering';
  if (f >= 1.8) return 'Water much less';
  if (f >= 1.4) return 'Water noticeably less';
  return 'Only slightly less';
}

// Step 1 — pick which plant you're troubleshooting. Diagnosis is tailored to the
// chosen plant's category, so there's no generic "all plants" list.
route(/^\/diagnose$/, () => {
  const view = el('div', { class: 'view' });
  view.append(viewHeader('Troubleshoot'));
  view.append(el('div', { class: 'guide-tabs' }, [
    el('button', { class: 'guide-tab', onClick: () => navigate('/guide') }, 'Plants'),
    el('button', { class: 'guide-tab active' }, 'Troubleshoot'),
  ]));
  view.append(el('p', { class: 'diagnose-intro' }, 'Which plant are you worried about? Pick it and the advice is tailored to that plant.'));

  const search = el('input', { class: 'field search', placeholder: '🔍 Search plants…' });
  view.append(search);

  const list = el('div', { class: 'guide-list' });
  function draw(filter = '') {
    clear(list);
    const q = filter.toLowerCase();
    allSpecies().filter((s) =>
      s.name.toLowerCase().includes(q) ||
      (s.latin || '').toLowerCase().includes(q) ||
      (s.aka || []).some((a) => a.toLowerCase().includes(q)),
    ).forEach((s) => {
      list.append(el('div', { class: 'guide-row', onClick: () => navigate(`/diagnose/${s.id}`) }, [
        el('span', { class: 'guide-emoji' }, categoryEmoji(s.category)),
        el('div', { class: 'guide-row-main' }, [
          el('div', { class: 'guide-name' }, s.name),
          el('div', { class: 'guide-latin' }, s.latin),
        ]),
        el('span', { class: 'guide-chevron' }, '›'),
      ]));
    });
    if (!list.children.length) list.append(el('div', { class: 'muted-box' }, 'No matches.'));
  }
  search.addEventListener('input', () => draw(search.value));
  draw();
  view.append(list);
  app.append(view);
});

// Step 2 — with a plant chosen, show the symptoms, led by that plant's biggest risk.
// Shared renderers, so the species-keyed routes (from the Troubleshoot tab) and
// the plant-keyed routes (from a plant's own page) look and behave identically.
// `ctx` = { name, latin, category, tips, back, symptomHref(symptomId) }.
function renderSymptomGrid(view, ctx) {
  view.append(viewHeader(ctx.name, { back: ctx.back }));
  view.append(el('div', { class: 'diagnose-plant' }, [
    el('span', { class: 'diagnose-plant-emoji' }, categoryEmoji(ctx.category)),
    el('div', {}, [
      el('div', { class: 'diagnose-plant-name' }, `Troubleshooting your ${ctx.name}`),
      ctx.latin ? el('div', { class: 'guide-latin' }, ctx.latin) : null,
    ]),
  ]));
  const lead = CATEGORY_LEAD[ctx.category];
  if (lead) view.append(el('div', { class: 'diagnose-lead' }, ['💡 ', lead]));
  view.append(el('p', { class: 'diagnose-intro' }, 'What are you seeing?'));
  const grid = el('div', { class: 'symptom-grid' });
  SYMPTOMS.forEach((sym) => {
    grid.append(el('button', { class: 'symptom-card', onClick: () => navigate(ctx.symptomHref(sym.id)) }, [
      el('span', { class: 'symptom-emoji' }, sym.emoji),
      el('span', { class: 'symptom-title' }, sym.title),
    ]));
  });
  view.append(grid);
}

function renderCauses(view, sym, ctx) {
  view.append(viewHeader(sym.title, { back: ctx.back }));
  // Pattern diagram: WHERE a symptom shows is what separates the causes.
  const art = symptomArt(sym.id);
  if (art) {
    view.append(el('div', { class: 'symptom-art' }, [
      el('div', { html: art.svg }),
      el('div', { class: 'symptom-art-caption', 'data-noloc': '1' }, art.caption),
    ]));
  }
  // A real, vetted example photo where a genuinely good one exists (only some
  // symptoms photograph meaningfully — the rest rely on the diagram).
  const symPhoto = SYMPTOM_PHOTOS[sym.id];
  if (symPhoto) {
    const card = refPhotoCard(symPhoto, 'Example');
    card.querySelector('.ref-cap').prepend(
      el('div', { class: 'symptom-art-caption', 'data-noloc': '1' }, symPhoto.caption[getLang() === 'nl' ? 'nl' : 'en']),
    );
    card.classList.add('symptom-photo');
    view.append(card);
  }
  view.append(el('div', { class: 'diagnose-head' }, [
    el('span', { class: 'diagnose-emoji' }, sym.emoji),
    `On your ${ctx.name}, most likely first:`,
  ]));
  const noun = CATEGORY_NOUN[ctx.category] || 'plant';
  tailorCauses(sym, ctx.category).forEach((c, i) => {
    view.append(el('div', { class: `cause-card rel-${c.relevance}` }, [
      el('div', { class: 'cause-name' }, [
        el('span', { class: 'cause-num' }, String(i + 1)),
        c.name,
        c.relevance === 'high' ? el('span', { class: 'cause-rel high' }, `likely for a ${noun}`) : null,
        c.relevance === 'low' ? el('span', { class: 'cause-rel low' }, `unusual for a ${noun}`) : null,
      ]),
      el('div', { class: 'cause-signs' }, [el('b', {}, 'Signs: '), c.signs]),
      el('div', { class: 'cause-fix' }, [el('b', {}, 'What to do: '), c.fix]),
    ]));
  });
  // Tie the plant's own care note in — the highest-signal, plant-specific bit.
  if (ctx.tips) view.append(el('div', { class: 'tips-box' }, [`💡 For your ${ctx.name}: `, ctx.tips]));
}

// ---- Plant-keyed troubleshooter (from a plant's own page) ----------------
// Registered BEFORE the species-keyed routes so "/diagnose/plant/…" isn't
// swallowed by the generic "/diagnose/<speciesId>" pattern. Works for any plant,
// including custom ones with no library species, by using its own category/tips.
route(/^\/diagnose\/plant\/([^/]+)\/([^/]+)$/, async (plantId, symptomId) => {
  const plant = await db.getPlant(plantId);
  const sym = getSymptom(symptomId);
  if (!plant) { navigate('/diagnose'); return; }
  if (!sym) { navigate(`/diagnose/plant/${plantId}`); return; }
  const s = plant.speciesId ? getSpecies(plant.speciesId) : null;
  const view = el('div', { class: 'view' });
  renderCauses(view, sym, {
    name: plant.name,
    category: plantCategory(plant),
    tips: (s && s.tips) || (plant.profile && plant.profile.tips) || '',
    back: `/diagnose/plant/${plantId}`,
  });
  app.append(view);
});

route(/^\/diagnose\/plant\/([^/]+)$/, async (plantId) => {
  const plant = await db.getPlant(plantId);
  if (!plant) { navigate('/diagnose'); return; }
  const s = plant.speciesId ? getSpecies(plant.speciesId) : null;
  const view = el('div', { class: 'view' });
  renderSymptomGrid(view, {
    name: plant.name,
    latin: plant.latin || (s && s.latin) || '',
    category: plantCategory(plant),
    back: `/plant/${plantId}`,
    symptomHref: (sid) => `/diagnose/plant/${plantId}/${sid}`,
  });
  app.append(view);
});

// ---- Species-keyed troubleshooter (from the Troubleshoot tab picker) ------
route(/^\/diagnose\/([^/]+)$/, (speciesId) => {
  const s = getSpecies(speciesId);
  if (!s) { navigate('/diagnose'); return; }
  const view = el('div', { class: 'view' });
  renderSymptomGrid(view, {
    name: s.name, latin: s.latin, category: s.category,
    back: '/diagnose', symptomHref: (sid) => `/diagnose/${s.id}/${sid}`,
  });
  app.append(view);
});

// Step 3 — the causes, re-ranked for this plant's category with relevance chips.
route(/^\/diagnose\/([^/]+)\/([^/]+)$/, (speciesId, symptomId) => {
  const s = getSpecies(speciesId);
  const sym = getSymptom(symptomId);
  if (!s) { navigate('/diagnose'); return; }
  if (!sym) { navigate(`/diagnose/${speciesId}`); return; }
  const view = el('div', { class: 'view' });
  renderCauses(view, sym, {
    name: s.name, category: s.category, tips: s.tips, back: `/diagnose/${speciesId}`,
  });
  app.append(view);
});

// =========================================================================
// SETTINGS
// =========================================================================

route(/^\/settings$/, async () => {
  const settings = getSettings();
  const [plants, events] = await Promise.all([db.getPlants(), db.getEvents()]);
  const view = el('div', { class: 'view' });
  view.append(viewHeader('Settings'));

  // Install app
  const installChildren = [];
  if (isStandalone()) {
    installChildren.push(el('div', { class: 'data-stat' }, '✅ You’re running the installed app.'));
  } else if (deferredInstallPrompt) {
    installChildren.push(el('button', { class: 'btn btn-primary full', onClick: triggerInstall }, '📲 Install on this device'));
    installChildren.push(el('div', { class: 'hint' }, 'Adds Plant Tracker to your home screen as a standalone app — its own icon, full-screen, works offline.'));
  } else {
    installChildren.push(el('div', { class: 'hint' }, [
      'No install button? This page has to be opened from its secure ', el('b', {}, 'https'), ' address to install as a real app. Once it is:',
      el('br', {}), el('br', {}),
      el('b', {}, '📱 Android (Chrome):'), ' ⋮ menu → “Add to Home screen”, then tap ', el('b', {}, 'Install'),
      ' on the popup (that installs the real app, not a shortcut).',
      el('br', {}), el('br', {}),
      el('b', {}, '🍎 iPhone (Safari):'), ' Share button → “Add to Home Screen”.',
      el('br', {}), el('br', {}),
      'On a home-screen icon: a real app opens full-screen with no address bar and appears in your app list; a plain shortcut opens inside a browser tab. If you only get a shortcut, the page isn’t on https yet — the README has a 1-minute step to fix that.',
    ]));
  }
  view.append(settingsGroup('Install app', installChildren));

  // Hemisphere
  const hemiSel = el('select', { class: 'field', onChange: (e) => { saveSettings({ hemisphere: e.target.value }); toast('Saved'); } }, [
    el('option', { value: 'N' }, 'Northern hemisphere'),
    el('option', { value: 'S' }, 'Southern hemisphere'),
  ]);
  hemiSel.value = settings.hemisphere;
  view.append(settingsGroup('Location', [
    labeled('Hemisphere', hemiSel),
    el('div', { class: 'hint' }, 'Determines seasons, which drive the watering and feeding adjustments.'),
  ]));

  // Theme
  const themeSel = el('select', { class: 'field', onChange: (e) => { saveSettings({ theme: e.target.value }); applyTheme(); toast('Saved'); } }, [
    el('option', { value: 'auto' }, 'Match device'),
    el('option', { value: 'light' }, 'Light'),
    el('option', { value: 'dark' }, 'Dark'),
  ]);
  themeSel.value = settings.theme;
  view.append(settingsGroup('Appearance', [labeled('Theme', themeSel)]));

  // Language & units — changing either re-renders so it takes effect at once.
  const langSel = el('select', { class: 'field', onChange: (e) => {
    saveSettings({ lang: e.target.value }); setLocale(e.target.value); toast('Saved'); render();
  } }, [
    el('option', { value: 'en' }, 'English'),
    el('option', { value: 'nl' }, 'Dutch'),
  ]);
  langSel.value = settings.lang || 'en';
  const unitsSel = el('select', { class: 'field', onChange: (e) => {
    const prev = settings.units || 'metric';
    const next = e.target.value;
    saveSettings({ units: next });
    render();
    // A metric↔imperial switch gets a playful quip in a tap-to-dismiss pop-up so
    // it can actually be read; a no-op re-select just confirms quietly.
    if (next !== prev) showTapPopup(unitSwitchMessage(next));
    else toast('Saved');
  } }, [
    el('option', { value: 'metric' }, 'Metric (cm, °C)'),
    el('option', { value: 'imperial' }, 'Imperial (in, °F)'),
  ]);
  unitsSel.value = settings.units || 'metric';
  view.append(settingsGroup('Measurements & language', [
    labeled('Language', langSel),
    el('div', { class: 'hint' }, 'Choose the app’s language.'),
    labeled('Units', unitsSel),
    el('div', { class: 'hint' }, 'Used for plant height and temperatures.'),
  ]));

  // Notifications
  const notifEnabled = native.isNative
    ? settings.notifications
    : settings.notifications && ('Notification' in window) && Notification.permission === 'granted';
  const notifBtn = el('button', { class: 'btn btn-secondary', onClick: async () => {
    // Native app: use the OS notification permission, then (re-)schedule the
    // on-device daily reminders. Web: the browser Notification permission.
    if (native.isNative) {
      const ok = await native.requestNativePermission();
      if (ok) { saveSettings({ notifications: true }); await rearmNative(); toast('Reminders on'); render(); }
      else toast('Permission denied');
      return;
    }
    if (!('Notification' in window)) { toast('Notifications not supported here'); return; }
    const perm = await Notification.requestPermission();
    if (perm === 'granted') { saveSettings({ notifications: true }); toast('Reminders on'); render(); }
    else toast('Permission denied');
  } }, notifEnabled ? '✅ Reminders enabled' : 'Enable reminders');
  const testBtn = el('button', { class: 'btn btn-ghost', onClick: sendTestReminder }, 'Send a test reminder');
  // Live status line — surfaces whether reminders are actually armed, so a silent
  // "never registered / blocked" state stops being invisible.
  const bgStatus = el('div', { class: 'hint', 'data-noloc': '' }, 'Checking reminders…');
  (native.isNative ? native.nativeNotificationStatus() : backgroundSyncStatus()).then((s) => {
    const nativeMsg = {
      active: '✅ Reminders are scheduled on your device. A daily summary appears at 9:00 whenever a plant needs care — even when the app is closed.',
      inactive: '⏳ Tap “Enable reminders” to let the app schedule daily plant-care notifications right on your device.',
      blocked: '⚠️ Notifications are turned off for this app in your phone’s settings, so reminders can’t appear. Turn them on in Settings › Apps › Plant Tracker › Notifications.',
      unsupported: 'ℹ️ Notifications aren’t available on this device.',
    };
    const webMsg = {
      active: '✅ Background reminders are active — Chrome may wake the app about once a day (it decides the exact timing, and can skip it to save battery).',
      inactive: '⏳ Background reminders aren’t running yet. Chrome turns them on automatically as you use the app more; until then you’re reminded when you open it. Tap “Send a test reminder” to confirm the reminder itself works.',
      blocked: '⚠️ Background reminders are blocked in this browser’s settings, so you’ll only be reminded when you open the app.',
      unsupported: 'ℹ️ This device can’t run background reminders (that needs an installed Android/Chrome app), so you’ll be reminded when you open or return to the app.',
    };
    bgStatus.textContent = (native.isNative ? nativeMsg : webMsg)[s.code] || '';
  }).catch(() => { bgStatus.textContent = ''; });
  const remindersHint = native.isNative
    ? 'Reminders are scheduled right on your device, so they arrive even when the app is closed — no internet needed. You’ll get a daily summary at 9:00 whenever something needs care.'
    : 'You’ll always get a “what needs care today” summary when you open or return to the app. On an installed Android app, it can also remind you about once a day in the background (Chrome decides the exact timing). iPhone doesn’t allow background reminders without a server, so there it’s open/reopen only.';
  const calBtn = el('button', { class: 'btn btn-secondary', onClick: exportPlantCalendar }, '📅 Add to calendar');
  const calHint = el('div', { class: 'hint' }, 'Optional — a separate way to get reminders. Tap to download a calendar file for the next 60 days; nothing is added to your calendar until you open the file and confirm. Events are grouped one per day, tagged “Plant care”, and shown as free time so they won’t crowd your schedule. Re-export anytime to refresh.');
  view.append(settingsGroup('Reminders', [
    notifBtn,
    testBtn,
    el('div', { class: 'hint' }, remindersHint),
    bgStatus,
    calBtn,
    calHint,
  ]));

  // AI health checks
  const keyInput = el('input', {
    type: 'password', class: 'field', placeholder: 'sk-ant-…', value: settings.apiKey || '',
    autocomplete: 'off', spellcheck: 'false',
  });
  keyInput.addEventListener('change', () => { saveSettings({ apiKey: keyInput.value.trim() }); toast('Saved'); });
  const showKey = el('input', { type: 'checkbox' });
  showKey.addEventListener('change', () => { keyInput.type = showKey.checked ? 'text' : 'password'; });
  const modelSel = el('select', { class: 'field', onChange: (e) => { saveSettings({ aiModel: e.target.value }); toast('Saved'); } },
    AI_MODELS.map((m) => el('option', { value: m.id }, m.label)));
  modelSel.value = settings.aiModel || 'claude-opus-4-8';

  view.append(settingsGroup('AI health checks', [
    labeled('Anthropic API key', keyInput),
    el('label', { class: 'checkline' }, [showKey, ' Show key']),
    labeled('Model', modelSel),
    el('div', { class: 'hint' }, [
      'Powers the ✨ AI health check — photograph a plant and get an expert read on its condition. ',
      'Get a key at ', el('b', {}, 'console.anthropic.com'), '. It’s stored only in this browser and used only for your health checks. ',
      'This is the one feature that sends data off your device: the photo you choose is sent to Anthropic for analysis.',
    ]),
  ]));

  // My plant food — one fertilizer used across all plants.
  const feed = settings.feed || {};
  const feedName = el('input', { class: 'field', placeholder: 'e.g. Miracle-Gro All Purpose', value: feed.name || '' });
  const feedNpk = el('input', { class: 'field', placeholder: 'e.g. 24-8-16 (optional)', value: feed.npk || '' });
  const feedMin = el('input', { type: 'number', min: '1', class: 'field', placeholder: '7', value: feed.minDays || '' });
  const feedMax = el('input', { type: 'number', min: '1', class: 'field', placeholder: '14', value: feed.maxDays || '' });
  const feedDilute = el('input', { type: 'checkbox' });
  feedDilute.checked = feed.dilute !== false; // default on (safer for houseplants)
  const saveFeed = () => {
    const name = feedName.value.trim();
    saveSettings({ feed: name ? {
      name, npk: feedNpk.value.trim(),
      minDays: +feedMin.value || null, maxDays: +feedMax.value || null,
      dilute: feedDilute.checked,
    } : null });
    toast('Saved');
  };
  [feedName, feedNpk, feedMin, feedMax].forEach((i) => i.addEventListener('change', saveFeed));
  feedDilute.addEventListener('change', saveFeed);
  const usePreset = el('button', { class: 'btn btn-secondary full', onClick: () => {
    feedName.value = 'Miracle-Gro Watering Can Singles';
    feedNpk.value = '24-8-16';
    feedMin.value = '7'; feedMax.value = '14';
    feedDilute.checked = true;
    saveFeed();
  } }, '🧪 Use Miracle-Gro Watering Can Singles');

  view.append(settingsGroup('My plant food', [
    el('div', { class: 'hint' }, 'The fertilizer you use on all your plants. It’s shown whenever the app tells you to feed, so you always know what (and how) to use.'),
    usePreset,
    labeled('Product name', feedName),
    labeled('N-P-K (optional)', feedNpk),
    el('div', { class: 'form-row' }, [
      el('span', { class: 'form-label' }, 'Label says feed every … days'),
      el('div', { class: 'feed-range' }, [feedMin, el('span', {}, 'to'), feedMax]),
    ]),
    el('label', { class: 'checkline' }, [feedDilute, ' Use ~half strength for foliage plants (recommended)']),
    el('div', { class: 'hint' }, 'The app spaces feeding by plant type automatically — flowering plants and herbs are fed more often, foliage plants monthly-ish, and succulents & cacti the least — and it pauses feeding in winter. Label frequencies like “every 7–14 days” are for fast growth, so keep foliage plants around half strength to avoid over-feeding.'),
  ]));

  // Data / backup
  view.append(settingsGroup('Your data', [
    el('div', { class: 'data-stat' }, `${plants.length} plant${plants.length === 1 ? '' : 's'} · ${events.length} log entr${events.length === 1 ? 'y' : 'ies'}`),
    el('button', { class: 'btn btn-secondary full', onClick: async () => {
      const data = await db.exportAll();
      download(`plant-tracker-backup-${todayISO()}.json`, JSON.stringify(data, null, 2));
      toast('Backup downloaded');
    } }, '⬇️ Export backup'),
    (() => {
      const input = el('input', { type: 'file', accept: 'application/json,.json', class: 'hidden-file' });
      input.addEventListener('change', async () => {
        const file = input.files[0]; if (!file) return;
        try {
          const data = JSON.parse(await file.text());
          confirmImport(data);
        } catch { toast('Could not read that file'); }
      });
      return el('label', { class: 'btn btn-secondary full' }, ['⬆️ Import backup', input]);
    })(),
    el('div', { class: 'hint' }, 'Everything is stored privately in this browser. Export regularly — clearing browser data will erase your plants.'),
  ]));

  view.append(el('div', { class: 'about' }, [
    el('div', {}, `🌿 Plant Care Tracker · v${APP_VERSION}`),
    el('div', { class: 'hint' }, 'Local-first · offline · installable. Your plants stay on this device — only AI health-check photos are sent out, and only when you use that feature.'),
  ]));

  app.append(view);
});

function confirmImport(data) {
  const m = modal([
    el('h3', { class: 'modal-title' }, 'Import backup'),
    el('p', { class: 'modal-text' }, `This file has ${data.plants?.length || 0} plants and ${data.events?.length || 0} log entries. How should it be applied?`),
    el('div', { class: 'modal-actions col' }, [
      el('button', { class: 'btn btn-primary', onClick: async () => {
        try { await db.importAll(data, { merge: false }); await reloadCustomSpecies(); m.close(); toast('Replaced with backup'); render(); }
        catch (e) { toast(e.message); }
      } }, 'Replace everything'),
      el('button', { class: 'btn btn-secondary', onClick: async () => {
        try { await db.importAll(data, { merge: true }); await reloadCustomSpecies(); m.close(); toast('Merged backup'); render(); }
        catch (e) { toast(e.message); }
      } }, 'Merge into current'),
      el('button', { class: 'btn btn-ghost', onClick: () => m.close() }, 'Cancel'),
    ]),
  ]);
}

function settingsGroup(title, children) {
  return el('div', { class: 'settings-group' }, [el('h2', { class: 'section-title' }, title), ...children]);
}

// ---- Shared empty state -------------------------------------------------

function emptyState(emoji, title, text, btnLabel, onClick) {
  return el('div', { class: 'empty' }, [
    el('div', { class: 'empty-emoji' }, emoji),
    el('div', { class: 'empty-title' }, title),
    el('div', { class: 'empty-text' }, text),
    btnLabel ? el('button', { class: 'btn btn-primary', onClick }, btnLabel) : null,
  ].filter(Boolean));
}

// =========================================================================
// THEME + NOTIFICATIONS + BOOT
// =========================================================================

function applyTheme() {
  const { theme } = getSettings();
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

// Ask the browser to wake the service worker ~daily to show reminders even when
// the app is closed. Only works on installed PWAs on Chromium (Android Chrome/
// Edge); silently unsupported elsewhere (iOS/Safari/Firefox) — those rely on the
// on-open check below.
async function registerPeriodicSync(reg) {
  if (!reg || !('periodicSync' in reg)) return;
  try {
    // There's no prompt for this permission — Chrome auto-grants it from the
    // site-engagement score. So don't gate on 'granted': attempt registration
    // unless it's been explicitly denied, and let register() reject harmlessly
    // if the browser isn't ready to grant it yet. backgroundSyncStatus() below
    // reports the real outcome to the user.
    let state = 'prompt';
    try { state = (await navigator.permissions.query({ name: 'periodic-background-sync' })).state; } catch { /* name unknown here */ }
    if (state !== 'denied') {
      try { await reg.periodicSync.register('plant-care-check', { minInterval: 24 * 60 * 60 * 1000 }); }
      catch { /* browser declined for now — not enough engagement yet */ }
    }
  } catch { /* not supported here */ }
}

// Live truth about whether background reminders can actually fire, checked at
// render time (permissions/registration can change between launches):
//   unsupported — this browser/OS has no Periodic Background Sync (iOS, desktop
//                 Firefox/Safari, or a non-installed context)
//   active      — registered; Chrome may wake us ~daily (its call on timing)
//   inactive    — supported but not registered yet (engagement too low so far)
//   blocked     — the permission is denied
async function backgroundSyncStatus() {
  if (!('serviceWorker' in navigator)) return { code: 'unsupported' };
  let reg = null;
  try { reg = await navigator.serviceWorker.ready; } catch { return { code: 'unsupported' }; }
  if (!reg || !('periodicSync' in reg)) return { code: 'unsupported' };
  let permission = 'prompt';
  try { permission = (await navigator.permissions.query({ name: 'periodic-background-sync' })).state; } catch { /* ignore */ }
  let registered = false;
  try { registered = (await reg.periodicSync.getTags()).includes('plant-care-check'); } catch { /* ignore */ }
  if (registered) return { code: 'active', permission };
  if (permission === 'denied') return { code: 'blocked', permission };
  return { code: 'inactive', permission };
}

// The single "Send a test reminder" button. It runs the SW's REAL background
// check on demand (force=true: bypass the once-per-day de-dup and always show a
// notification — a sample if nothing's actually due), so it faithfully tests the
// exact digest → notification path Chrome's periodic sync uses. That isolates
// "is the pipeline broken?" from "did Chrome bother to run it?" — and, unlike a
// page-fired notification, it exercises the mechanism that can actually fail.
//
// It also carries the two safety behaviours a bare notification test lacks: it
// requests OS permission if needed, and — since the test shows regardless of the
// in-app toggle — warns when daily reminders are switched off, so a working test
// never masks a switched-off reminder.
async function sendTestReminder() {
  const nl = getLang() === 'nl';
  // Native app: schedule a one-off notification through the OS to prove the
  // on-device delivery path works (permission → channel → notification).
  if (native.isNative) {
    const shown = await native.sendTestNotification({ lang: getLang() });
    if (!shown) {
      toast(nl ? 'Kon de test niet tonen — staan meldingen aan voor de app?' : 'Couldn’t show the test — are the app’s notifications allowed?');
      return;
    }
    if (!getSettings().notifications) {
      showTapPopup(nl
        ? 'De test werkt — maar je dagelijkse herinneringen staan UIT. Zet “Herinneringen” aan om ze echt te ontvangen.'
        : 'The test works — but your daily reminders are OFF. Turn on “Reminders” to actually receive them.');
    } else {
      toast(nl ? 'Testmelding verstuurd (verschijnt zo)' : 'Test reminder sent (appears shortly)');
    }
    return;
  }
  if (!('Notification' in window)) { toast(nl ? 'Meldingen worden hier niet ondersteund' : 'Notifications not supported here'); return; }
  let perm = Notification.permission;
  if (perm !== 'granted') perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast(nl ? 'Toestemming geweigerd' : 'Permission denied'); return; }
  if (!('serviceWorker' in navigator)) { toast(nl ? 'Niet ondersteund op dit apparaat' : 'Not supported on this device'); return; }

  // Make sure the SW reads a current digest, not one from a stale earlier visit.
  await refreshReminderState();
  let reg;
  try { reg = await navigator.serviceWorker.ready; } catch { reg = null; }
  const worker = reg && (reg.active || navigator.serviceWorker.controller);
  if (!worker) { toast(nl ? 'Service worker nog niet actief — probeer zo nog eens' : 'Service worker not active yet — try again in a moment'); return; }

  const reply = new Promise((resolve) => {
    const onMsg = (e) => {
      if (e.data && e.data.type === 'REMINDER_CHECK_RESULT') {
        navigator.serviceWorker.removeEventListener('message', onMsg);
        resolve(e.data);
      }
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    setTimeout(() => { navigator.serviceWorker.removeEventListener('message', onMsg); resolve(null); }, 5000);
  });
  worker.postMessage({ type: 'RUN_REMINDER_CHECK', force: true });
  const res = await reply;

  if (!res) { toast(nl ? 'Geen reactie van de achtergrond-worker' : 'No response from the background worker'); return; }
  if (!res.shown) {
    toast(nl ? 'De melding kon niet worden getoond — controleer of meldingen voor de app aanstaan in Android' : 'Couldn’t show it — check the app’s notifications are allowed in Android settings');
    return;
  }
  // The test shows regardless of the toggle; if daily reminders are off, the real
  // ones still won't fire — say so rather than let a working test reassure falsely.
  if (!getSettings().notifications) {
    showTapPopup(nl
      ? 'De test werkt — maar je dagelijkse herinneringen staan UIT. Zet “Herinneringen” aan om ze echt te ontvangen.'
      : 'The test works — but your daily reminders are OFF. Turn on “Reminders” above to actually receive them.');
    return;
  }
  toast(res.sample
    ? (nl ? 'Werkt ✓ — voorbeeld (er staat nu niets echt te doen)' : 'Works ✓ — sample (nothing is actually due now)')
    : (nl ? 'Herinnering werkt ✓' : 'Reminder works ✓'));
}

// A stable local-date key (YYYY-M-D) used to send each plant/task at most one
// reminder per calendar day — the anti-spam guard shared by the foreground and
// background notifiers. Mirrored in sw.js; keep the two in sync.
function reminderDayKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// How many whole days past due a task is (0 = due today, 1 = a day overdue…).
function reminderOverdueDays(dueISO, now) {
  const s = (x) => { const y = new Date(x); y.setHours(0, 0, 0, 0); return y.getTime(); };
  return Math.round((s(now) - s(dueISO)) / (24 * 60 * 60 * 1000));
}

// Turn a set of due/overdue tasks into an escalating, plant-specific message.
// Names the at-risk plant when it's just one or two, summarizes when it's many,
// and always surfaces the most-overdue plant so it doesn't get lost. Mirrored in
// sw.js (the background notifier). Returns { title, body } or null.
function formatReminder(tasks, now, lang = getLang()) {
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

// Seasonal pruning/repotting nudges — fired at most once per plant/kind/year, so
// they don't repeat daily through the whole of spring. Each deep-links to the
// plant's how-to. Shared idea with the SW's copy in sw.js.
async function fireSeasonalNudges(plants, events, settings, now) {
  const nudges = gatherSeasonalNudges(plants, events, settings, now);
  if (!nudges.length) return;
  const yr = now.getFullYear();
  const slog = (await db.getMeta('seasonalNudgeLog')) || {};
  for (const n of nudges) {
    const key = `${n.plantId}|${n.kind}|${yr}`;
    if (slog[key]) continue;
    slog[key] = true;
    await showReminderNotification({ title: n.title, body: n.body }, {
      tag: `plant-seasonal-${n.plantId}-${n.kind}`,
      data: { url: n.url },
    });
  }
  await db.putMeta('seasonalNudgeLog', slog);
}

async function checkReminders() {
  const settings = getSettings();
  if (!settings.notifications || !('Notification' in window) || Notification.permission !== 'granted') return;
  const now = new Date();
  const [plants, events] = await Promise.all([db.getPlants(), db.getEvents()]);
  await fireSeasonalNudges(plants, events, settings, now);
  const due = dueTasks(plants, events, now, settings.hemisphere, 0)
    .map((t) => ({ plantId: t.plant.id, name: t.plant.name, type: t.type, due: t.due.toISOString() }));
  const photoDue = plants.filter((p) => photoStatus(p, events, now).due)
    .map((p) => ({ plantId: p.id, name: p.name, type: 'photo', due: now.toISOString() }));
  const all = due.concat(photoDue);
  if (!all.length) { await db.putMeta('notifyLog', {}); return; }

  // Once-per-day de-dup: only notify about tasks we haven't already flagged today.
  const today = reminderDayKey(now);
  const log = (await db.getMeta('notifyLog')) || {};
  const fresh = all.filter((t) => log[`${t.plantId}|${t.type}`] !== today);
  // Stamp every currently-due task as handled today (this also drops keys for
  // tasks that were watered/fed since — so tomorrow the still-due ones repeat).
  const newLog = {};
  for (const t of all) newLog[`${t.plantId}|${t.type}`] = today;
  await db.putMeta('notifyLog', newLog);
  if (!fresh.length) return; // already reminded about all of these today — no spam

  const msg = formatReminder(fresh, now);
  if (!msg) return;
  await showReminderNotification(msg);
}

// Native (installed app) reminder scheduling: pre-schedule the next 30 days of
// daily care summaries so they fire even when the app is fully closed — the OS
// alarm clock delivers them, no server or push needed. No-op on the web, where
// checkReminders + the service worker handle notifications instead.
async function rearmNative() {
  const settings = getSettings();
  const [plants, events] = await Promise.all([db.getPlants(), db.getEvents()]);
  return native.rearmReminders({ plants, events, settings, formatReminder, now: new Date() });
}

// Optional, opt-in reminder path: only runs when the user taps "Add to calendar".
// Exports the next ~2 months of plant care as an .ics file the user chooses to
// open into their own calendar (Google/Apple/Outlook) — nothing is added to any
// calendar until they open the downloaded file and their calendar confirms.
async function exportPlantCalendar() {
  const nl = getLang() === 'nl';
  const settings = getSettings();
  const [plants, events] = await Promise.all([db.getPlants(), db.getEvents()]);
  if (!plants.length) { toast(nl ? 'Voeg eerst een plant toe' : 'Add a plant first'); return; }
  // Remember what we exported last time so this export can cancel days that have
  // since dropped off the schedule, and bump the sequence so updates take effect.
  const prev = (await db.getMeta('calendarExport')) || { seq: 0, days: [] };
  const seq = (prev.seq || 0) + 1;
  const result = buildPlantCareICS({
    plants, events, settings, formatReminder, now: new Date(),
    prevDays: prev.days || [], seq, lang: getLang(),
  });
  if (!result) { toast(nl ? 'Nog niets in te plannen' : 'Nothing to schedule yet'); return; }

  // How the events reach the calendar differs by platform: the native app opens
  // the calendar app directly; the web downloads a file the user opens.
  const how = native.isNative
    ? (nl
        ? 'Je agenda-app opent met de afspraken erin — tik daar op “Alles toevoegen” of “Opslaan” om ze te bewaren. Er wordt niets toegevoegd zonder jouw bevestiging.'
        : 'Your calendar app will open showing the events — tap “Add all” / “Save” there to keep them. Nothing is added without your confirmation.')
    : (nl
        ? 'Er wordt een bestand “plant-care.ics” gedownload. Open het om de afspraken aan je agenda toe te voegen.'
        : 'A “plant-care.ics” file downloads — open it to add the events to your calendar.');

  // Confirm step with an explicit "Add to calendar" / "Later" choice, so nothing
  // is exported until the user opts in.
  const m = modal([
    el('h3', { class: 'modal-title', 'data-noloc': '' }, nl ? 'Aan je agenda toevoegen?' : 'Add to your calendar?'),
    el('p', { 'data-noloc': '' }, nl
      ? `${result.eventCount} plantenzorg-herinneringen voor de komende ~2 maanden.`
      : `${result.eventCount} plant-care reminders for the next ~2 months.`),
    el('p', { class: 'hint', 'data-noloc': '' }, how),
    el('div', { class: 'modal-actions' }, [
      el('button', { class: 'btn btn-ghost', 'data-noloc': '', onClick: () => m.close() }, nl ? 'Later' : 'Later'),
      el('button', { class: 'btn btn-primary', 'data-noloc': '', onClick: async () => {
        m.close();
        // Only record this export (for next time's cleanup) once the user commits.
        await db.putMeta('calendarExport', { seq, days: result.days });
        if (native.isNative) {
          const opened = await native.openCalendarFile(result.ics);
          if (!opened) download('plant-care.ics', result.ics, 'text/calendar'); // fallback
        } else {
          download('plant-care.ics', result.ics, 'text/calendar');
        }
      } }, nl ? '📅 Aan agenda toevoegen' : '📅 Add to calendar'),
    ]),
  ]);
}

// Show a reminder notification. Chrome on Android FORBIDS the `new Notification()`
// constructor (it throws "Illegal constructor") — notifications must be shown via
// the service-worker registration. So prefer registration.showNotification()
// everywhere, and fall back to the constructor only where no service worker is
// available (some older desktop browsers). Matches the icon/badge the SW uses.
async function showReminderNotification(msg, extra = {}) {
  const opts = {
    body: msg.body,
    tag: extra.tag || 'plant-care-daily',
    icon: './icons/icon-192.png',
    badge: './icons/icon-192.png',
    ...(extra.data ? { data: extra.data } : {}),
  };
  if ('serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.ready;
      await reg.showNotification(msg.title, opts);
      return;
    } catch { /* fall through to the constructor */ }
  }
  try { new Notification(msg.title, opts); } catch { /* ignore */ }
}

window.addEventListener('hashchange', render);

async function boot() {
  applyTheme();
  setLocale(getLang());
  // Capture the install opportunity and reflect it in the UI when it appears.
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    render();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    toast('Installed! Look for it on your home screen.');
    render();
  });
  await db.openDB();
  await runMigrations();
  await reloadCustomSpecies();
  await render();

  if (native.isNative) {
    // Native app: the OS delivers pre-scheduled reminders even when the app is
    // closed, so we (re-)arm the schedule on open, on resume, and hourly instead
    // of running the in-app web notifier (which would double-fire). We do NOT
    // return here — the service worker still registers below so the hosted
    // content (loaded via server.url) is cached for offline use.
    await native.initNative({
      onResume: () => { rearmNative(); },
      onOpen: (url) => { if (url) location.hash = String(url).replace(/^#/, ''); },
    });
    rearmNative();
    setInterval(rearmNative, 60 * 60 * 1000);
  } else {
    // Web: check reminders shortly after open, then hourly while the app is open.
    setTimeout(checkReminders, 4000);
    setInterval(checkReminders, 60 * 60 * 1000);
  }

  // Register the service worker on BOTH web and native. On the web it provides
  // offline + installability + the update prompt; in the native app (which loads
  // the live site via server.url) it caches that hosted content for offline use
  // and surfaces the same "new version ready" prompt when a release ships.
  if ('serviceWorker' in navigator) {
    // When the controlling worker changes because we asked it to, reload into
    // the new version. (Guarded so the first-ever registration doesn't reload.)
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (swUpdating) window.location.reload();
    });
    // A tapped notification asks the (already-open) app to jump to a plant's
    // how-to. Cold starts arrive via the URL hash instead (openWindow in sw.js).
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'navigate' && typeof e.data.url === 'string') {
        location.hash = e.data.url.replace(/^#/, '');
      }
    });
    navigator.serviceWorker.register('./sw.js').then((reg) => {
      // A newer version was already waiting (updated while the app was closed).
      if (reg.waiting && navigator.serviceWorker.controller) showUpdatePrompt(reg.waiting);
      // A new version starts downloading now.
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdatePrompt(nw);
          }
        });
      });
      // Check for a new version hourly and whenever the app regains focus.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
      // Best-effort background reminders — web PWA only (the native app uses
      // scheduled local notifications instead).
      if (!native.isNative) registerPeriodicSync(reg);
    }).catch(() => {});
  }
}

boot();
