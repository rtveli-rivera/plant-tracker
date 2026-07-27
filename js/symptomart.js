// symptomart.js — Small SVG "pattern diagrams" for the symptom troubleshooter.
//
// Deliberately schematic, not photographic: what distinguishes causes is WHERE
// on the plant a symptom shows (lower leaves vs tips vs all over), and a clean
// diagram teaches that pattern better than a photo of someone else's plant.
// Bundling real photos per species × symptom would add 6–9 MB and a licensing
// burden; these 7 vectors add ~15 KB, work offline, and follow the app theme
// via CSS variables. Purely pictorial (no embedded text) so nothing needs
// translating inside the SVGs — captions are localized here instead.

import { getLang } from './i18n.js';

const GREEN = 'var(--green)';
const AMBER = 'var(--amber)';
const BROWN = '#a5683a'; // literal so it reads as "dead leaf" in both themes
const DIM = 'var(--text-dim)';

// A leaf as a rotated group so optional extras (brown tip, pest specks) rotate
// with it. `dir` = 1 when the leaf points right of its stem, -1 when left.
function leaf(cx, cy, angle, fill, { tip = null, specks = false, dir = 1, rx = 14, ry = 6 } = {}) {
  const extras = [];
  if (tip) extras.push(`<ellipse cx="${cx + dir * (rx - 3)}" cy="${cy}" rx="4.5" ry="3.2" fill="${tip}"/>`);
  if (specks) extras.push(
    `<circle cx="${cx - 4}" cy="${cy - 2}" r="1.3" fill="var(--red)"/>`,
    `<circle cx="${cx + 3}" cy="${cy + 1}" r="1.3" fill="var(--red)"/>`,
    `<circle cx="${cx + 8}" cy="${cy - 2}" r="1.3" fill="var(--red)"/>`,
  );
  return `<g transform="rotate(${angle} ${cx} ${cy})"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"/>${extras.join('')}</g>`;
}

function stem(d) {
  return `<path d="${d}" fill="none" stroke="${GREEN}" stroke-width="2.5" stroke-linecap="round"/>`;
}

// Pot + soil, shared by every diagram.
const POT = `
  <ellipse cx="130" cy="89" rx="21" ry="3.5" fill="var(--border)"/>
  <rect x="103" y="86" width="54" height="8" rx="3" fill="var(--surface-2)" stroke="var(--border)"/>
  <path d="M108 94 L152 94 L147 117 L113 117 Z" fill="var(--surface-2)" stroke="var(--border)"/>`;

function svg(inner) {
  return `<svg viewBox="0 0 260 124" xmlns="http://www.w3.org/2000/svg" role="img" aria-hidden="true">${inner}</svg>`;
}

// The classic healthy silhouette most diagrams start from.
const UP_STEMS =
  stem('M130 88 C120 70 108 60 96 52') +
  stem('M130 88 C126 66 118 50 112 38') +
  stem('M130 88 C134 66 142 50 148 38') +
  stem('M130 88 C140 70 152 60 164 52');
const LOW_STEMS =
  stem('M130 88 C116 80 102 76 90 74') +
  stem('M130 88 C144 80 158 76 170 74');

const ART = {
  'yellow-leaves': svg(
    POT + UP_STEMS + LOW_STEMS +
    leaf(92, 50, -35, GREEN, { dir: -1 }) +
    leaf(110, 36, -62, GREEN, { dir: -1 }) +
    leaf(150, 36, 62, GREEN) +
    leaf(168, 50, 35, GREEN) +
    // the pattern: only the lowest, oldest leaves have turned
    leaf(86, 73, -12, AMBER, { dir: -1 }) +
    leaf(174, 73, 12, AMBER),
  ),
  'brown-tips': svg(
    POT + UP_STEMS + LOW_STEMS +
    leaf(92, 50, -35, GREEN, { dir: -1, tip: BROWN }) +
    leaf(110, 36, -62, GREEN, { dir: -1, tip: BROWN }) +
    leaf(150, 36, 62, GREEN, { tip: BROWN }) +
    leaf(168, 50, 35, GREEN, { tip: BROWN }) +
    leaf(86, 73, -12, GREEN, { dir: -1, tip: BROWN }) +
    leaf(174, 73, 12, GREEN, { tip: BROWN }),
  ),
  drooping: svg(
    POT +
    stem('M130 88 C118 62 100 60 92 76') +
    stem('M130 88 C126 56 112 56 105 72') +
    stem('M130 88 C134 56 148 56 155 72') +
    stem('M130 88 C142 62 160 60 168 76') +
    leaf(90, 81, -75, GREEN, { dir: -1 }) +
    leaf(103, 78, -80, GREEN, { dir: -1 }) +
    leaf(157, 78, 80, GREEN) +
    leaf(170, 81, 75, GREEN),
  ),
  'leaf-drop': svg(
    POT +
    stem('M130 88 C126 66 118 50 112 38') +
    stem('M130 88 C134 66 142 50 148 38') +
    stem('M130 88 C120 70 108 60 96 52') +
    leaf(110, 36, -62, GREEN, { dir: -1 }) +
    leaf(150, 36, 62, GREEN) +
    leaf(92, 50, -35, GREEN, { dir: -1 }) +
    // leaves that let go: mid-fall and on the ground
    `<g opacity="0.9">${leaf(196, 62, 130, AMBER)}</g>` +
    `<g opacity="0.85">${leaf(210, 108, 15, BROWN)}</g>` +
    `<path d="M188 44 q6 8 -2 14 M198 84 q-6 8 2 12" fill="none" stroke="${DIM}" stroke-width="1" stroke-dasharray="2 3" opacity="0.7"/>`,
  ),
  pests: svg(
    POT + UP_STEMS +
    leaf(92, 50, -35, GREEN, { dir: -1, specks: true }) +
    leaf(110, 36, -62, GREEN, { dir: -1 }) +
    leaf(150, 36, 62, GREEN, { specks: true }) +
    leaf(168, 50, 35, GREEN) +
    // fine webbing between leaves
    `<path d="M100 46 L118 34 M104 52 L126 44 M112 42 L124 52" stroke="${DIM}" stroke-width="0.8" opacity="0.6"/>` +
    // gnats around the soil
    `<g fill="${DIM}"><circle cx="170" cy="86" r="1.8"/><circle cx="182" cy="76" r="1.8"/><circle cx="176" cy="94" r="1.8"/></g>` +
    `<path d="M166 82 q4 -3 8 0 M178 72 q4 -3 8 0 M172 90 q4 -3 8 0" stroke="${DIM}" stroke-width="0.8" fill="none" opacity="0.7"/>`,
  ),
  'soil-mold': svg(
    POT + UP_STEMS +
    leaf(92, 50, -35, GREEN, { dir: -1 }) +
    leaf(110, 36, -62, GREEN, { dir: -1 }) +
    leaf(150, 36, 62, GREEN) +
    leaf(168, 50, 35, GREEN) +
    // fuzzy white patches sitting on the soil line
    `<g fill="#fff" stroke="var(--border)" stroke-width="0.5" opacity="0.92">
       <circle cx="116" cy="88" r="3.4"/><circle cx="121" cy="87" r="2.6"/><circle cx="112" cy="87" r="2.2"/>
       <circle cx="140" cy="89" r="3"/><circle cx="145" cy="88" r="2.4"/>
     </g>`,
  ),
  'no-growth': svg(
    POT +
    stem('M130 88 C124 74 116 66 108 60') +
    stem('M130 88 C136 74 144 66 152 60') +
    leaf(104, 58, -40, GREEN, { dir: -1, rx: 12, ry: 5.5 }) +
    leaf(156, 58, 40, GREEN, { rx: 12, ry: 5.5 }) +
    // the growth that isn't happening: a dashed ghost above
    `<g fill="none" stroke="${DIM}" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.65">
       <path d="M130 88 C128 60 122 44 116 32"/>
       <path d="M130 88 C132 60 138 44 144 32"/>
       <ellipse cx="112" cy="29" rx="12" ry="5.5" transform="rotate(-55 112 29)"/>
       <ellipse cx="148" cy="29" rx="12" ry="5.5" transform="rotate(55 148 29)"/>
     </g>`,
  ),
};

// One short lesson per diagram: how to READ the pattern. Localized here (the
// SVGs are text-free on purpose).
const CAPTION = {
  'yellow-leaves': {
    en: 'Read the pattern: only the lowest leaves → aging or overwatering; pale new growth → hungry; yellow and crispy all over → too dry.',
    nl: 'Lees het patroon: alleen de onderste bladeren → veroudering of te veel water; bleke nieuwe groei → voeding nodig; overal geel én knisperig → te droog.',
  },
  'brown-tips': {
    en: 'Brown starts at the tips and edges — dry air, harsh tap water, or uneven watering. Brown patches mid-leaf are a different story (usually sunburn or fungus).',
    nl: 'Bruin begint bij de punten en randen — droge lucht, hard kraanwater of onregelmatig gieten. Bruine vlekken midden op het blad zijn iets anders (meestal zonnebrand of schimmel).',
  },
  drooping: {
    en: 'Limp all over. Feel the soil before acting: dry = thirsty; wet = the roots are drowning. The fixes are opposites, so always check first.',
    nl: 'Alles hangt slap. Voel eerst de aarde: droog = dorst; nat = de wortels verdrinken. De oplossingen zijn elkaars tegenpolen, dus voel altijd eerst.',
  },
  'leaf-drop': {
    en: 'Leaves letting go, often still green — usually shock after a move or repot, watering swings, or too little light.',
    nl: 'Bladeren laten los, vaak nog groen — meestal schrik na een verhuizing of verpotbeurt, wisselvallig gieten of te weinig licht.',
  },
  pests: {
    en: 'Look closely: fine webbing = spider mites; little black flies at the soil = fungus gnats; white cottony fuzz in the joints = mealybugs.',
    nl: 'Kijk goed: fijne webjes = spintmijt; kleine zwarte vliegjes bij de aarde = varenrouwmug; witte pluisjes in de oksels = wolluis.',
  },
  'soil-mold': {
    en: 'White on the soil while the plant looks fine: fuzzy = harmless surface mold (let it dry, add airflow); crusty = fertilizer salts (flush the pot).',
    nl: 'Wit op de aarde terwijl de plant er goed uitziet: pluizig = onschuldige schimmel (laat drogen, zorg voor luchtstroom); korstig = meststofzouten (spoel de pot door).',
  },
  'no-growth': {
    en: 'No new leaves. In autumn and winter that is healthy rest; in the growing season it usually means more light — or roots that have run out of room.',
    nl: 'Geen nieuw blad. In herfst en winter is dat gezonde rust; in het groeiseizoen betekent het meestal: meer licht — of wortels die geen ruimte meer hebben.',
  },
};

export function symptomArt(id) {
  const art = ART[id];
  if (!art) return null;
  const cap = CAPTION[id];
  return { svg: art, caption: cap ? cap[getLang() === 'nl' ? 'nl' : 'en'] : '' };
}
