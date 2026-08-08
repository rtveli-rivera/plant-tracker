// coach.js — Natural-language care coaching, generated locally (no AI, offline).
//
// Turns a plant's species profile + the current season into warm, human-sounding
// guidance — the "great choice, here's how to keep it thriving" message a
// knowledgeable friend would give you when you bring a new plant home.

import { getSpecies, LIGHT } from './species.js';
import { seasonForDate, SEASON_META, shouldFeed } from './season.js';
import { effectiveWaterInterval, effectiveFeedInterval, plantCategory } from './schedule.js';
import { getLang, tl } from './i18n.js';

const SEASON_LABEL_NL = { spring: 'lente', summer: 'zomer', autumn: 'herfst', winter: 'winter' };

const DIFFICULTY_OPENERS_NL = {
  easy: [
    'Mooie keuze — {name} is een van de meest vergevingsgezinde kamerplanten die je kunt hebben.',
    'Leuke keuze. {name} staat bekend als heel makkelijk, dus je begint op easy mode.',
    'Fijn — {name} is een taaie, onverwoestbare plant.',
  ],
  moderate: [
    'Goede keuze — {name} is niet moeilijk, hij houdt gewoon van een beetje regelmaat.',
    'Leuke keuze. {name} is heel goed te doen zodra je zijn ritme te pakken hebt.',
    '{name} is een dankbare plant — een beetje aandacht doet veel.',
  ],
  hard: [
    'Gedurfde keuze — {name} is wat eigenwijs, maar prachtig als hij gelukkig is.',
    '{name} staat bekend als lastig, maar je kunt hem zeker gezond houden.',
    'Een opvallende keuze. {name} beloont zorg en regelmaat, dus laten we je goed op weg helpen.',
  ],
};

// Deterministic pick so a given plant always gets the same phrasing.
function hash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function pick(options, seed) {
  return options[seed % options.length];
}

const DIFFICULTY_OPENERS = {
  easy: [
    'Great pick — {name} is one of the most forgiving houseplants you can own.',
    'Lovely choice. {name} is famously easy-going, so you\'re starting on easy mode.',
    'Nice — {name} is a hardy, low-drama plant that\'s tough to kill.',
  ],
  moderate: [
    'Good choice — {name} isn\'t difficult, it just likes a bit of consistency.',
    'Nice pick. {name} is very doable once you settle into its rhythm.',
    '{name} is a rewarding plant — a little attention goes a long way.',
  ],
  hard: [
    'Bold choice — {name} is a bit particular, but stunning when it\'s happy.',
    '{name} has a reputation for being fussy, but you can absolutely keep it thriving.',
    'A striking pick. {name} rewards care and consistency, so let\'s set you up well.',
  ],
};

function speciesName(plant) {
  const s = plant.speciesId ? getSpecies(plant.speciesId) : null;
  return s ? s.name : (plant.latin || 'this plant');
}

// A short, friendly welcome paragraph for a newly-added (or existing) plant.
export function welcomeMessage(plant, settings, now = new Date()) {
  const nl = getLang() === 'nl';
  const s = plant.speciesId ? getSpecies(plant.speciesId) : null;
  const seed = hash(plant.id || plant.name || 'plant');
  const name = s ? tl(s.name) : (plant.latin || (nl ? 'Je nieuwe plant' : 'Your new plant'));
  const diff = s ? s.difficulty : (plant.profile.difficulty || 'moderate');
  const openers = nl ? DIFFICULTY_OPENERS_NL : DIFFICULTY_OPENERS;
  const opener = pick(openers[diff] || openers.moderate, seed).replace('{name}', name);

  const season = seasonForDate(now, settings.hemisphere);
  const interval = effectiveWaterInterval(plant.profile, now, settings.hemisphere, plant.conditions);
  const light = tl(LIGHT[plant.profile.light] || plant.profile.light).toLowerCase();

  if (nl) {
    const seasonLbl = SEASON_LABEL_NL[season];
    const waterLine = `Op dit moment (${seasonLbl}) geef je ongeveer elke ${interval} dag${interval === 1 ? '' : 'en'} water — check altijd eerst of de bovenkant van de aarde droog is.`;
    const lightLine = `Zet 'm in ${light} en hij voelt zich prima.`;
    return `${opener} ${waterLine} ${lightLine}`;
  }

  const meta = SEASON_META[season];
  const waterLine = `Right now (${meta.label.toLowerCase()}), aim to water about every ${interval} day${interval === 1 ? '' : 's'} — always check that the top of the soil has dried first.`;
  const lightLine = `Give it ${light} and it'll be happy.`;
  return `${opener} ${waterLine} ${lightLine}`;
}

// Concrete, do-this-now care tips (the "X, Y and Z" list).
export function careTips(plant, settings, now = new Date()) {
  const nl = getLang() === 'nl';
  const s = plant.speciesId ? getSpecies(plant.speciesId) : null;
  const p = plant.profile;
  const season = seasonForDate(now, settings.hemisphere);
  const interval = effectiveWaterInterval(p, now, settings.hemisphere, plant.conditions);
  const feeding = shouldFeed(season, p.feedWinter);
  const light = tl(LIGHT[p.light] || p.light).toLowerCase();
  const tips = [];

  tips.push({
    icon: '💧',
    text: nl
      ? `Geef dit seizoen ongeveer elke ${interval} dag${interval === 1 ? '' : 'en'} water — laat de aarde tot de juiste diepte uitdrogen voordat je opnieuw water geeft, in plaats van op een strak schema te gieten.`
      : `Water roughly every ${interval} day${interval === 1 ? '' : 's'} this season — let the soil dry to the right depth between drinks rather than watering on a strict clock.`,
  });

  // How much, not just how often — the other half of watering, and the part that
  // stops people drowning a plant with daily splashes.
  tips.push({ icon: '🚿', text: wateringAmount(plant).text });

  tips.push({
    icon: '☀️',
    text: nl
      ? `Zet 'm in ${light}. Draai 'm af en toe zodat hij gelijkmatig groeit.`
      : `Place it in ${light}. Turn it now and then so it grows evenly.`,
  });

  if (p.fertilize) {
    const feed = settings.feed;
    const feedWith = (feed && feed.name)
      ? `${feed.name}${feed.dilute ? (nl ? ' op ongeveer halve sterkte' : ' at about half strength') : ''}`
      : (nl ? 'een evenwichtige meststof op halve sterkte' : 'a balanced fertilizer at half strength');
    tips.push({
      icon: '🌱',
      text: feeding
        ? (nl
          ? `Voed met ${feedWith} ongeveer elke ${effectiveFeedInterval(plant)} dagen zolang hij actief groeit — meng 'm door het gietwater in plaats van op droge aarde te voeden.`
          : `Feed with ${feedWith} about every ${effectiveFeedInterval(plant)} days while it's actively growing — mix it into a watering rather than feeding dry soil.`)
        : (nl
          ? `Even geen mest nu — voeden begint weer in de lente als de groei op gang komt.`
          : `Hold off on fertilizer for now — feeding resumes in spring when growth picks back up.`),
    });
  }

  if (p.humidity && /high/i.test(p.humidity)) {
    const humNL = /very high/i.test(p.humidity) ? 'een zeer hoge' : 'een hoge';
    tips.push({ icon: '💦', text: nl
      ? `Hij houdt van ${humNL} luchtvochtigheid — zet 'm bij andere planten of gebruik een schaal met kiezels, vooral als de verwarming aan is.`
      : `It likes ${p.humidity.toLowerCase()} humidity — group it with other plants or use a pebble tray, especially with heating on.` });
  }

  if (p.toxic && /toxic/i.test(p.toxic) && !/non-toxic|pet safe/i.test(p.toxic)) {
    tips.push({ icon: '🐾', text: nl
      ? `Houd 'm buiten bereik van huisdieren en kleine kinderen — ${tl(p.toxic).toLowerCase()}.`
      : `Keep it out of reach of pets and small children — ${p.toxic.toLowerCase()}.` });
  }

  const tipText = s ? tl(s.tips) : p.tips;
  if (tipText) {
    tips.push({ icon: '💡', text: tipText });
  }

  return tips;
}

// How MUCH to water — the missing half of watering guidance. The schedule tells
// you when; this tells you the amount and method so people don't drown a plant
// with daily splashes (the #1 way houseplants die). Keyed by plant type, because
// "how much" is a property of the type: succulents want soak-and-dry, ferns want
// evenly moist, most tropicals want a thorough drench then a partial dry-down.
// Returns { label } — a short method tag for compact spots — and { text } — the
// full plain-language guidance. "Until it drains from the bottom" scales the
// volume to the pot on its own, which is why it beats naming a fixed amount.
const WATER_AMOUNT = {
  succulent: {
    en: {
      label: 'Soak & dry — never a daily splash',
      text: 'Give it a proper soak — water until it runs out the drainage holes, then don\'t water again until the soil is bone dry (often a week or two). A daily splash is what rots succulents; one big drink followed by a long dry spell is what they actually want.',
    },
    nl: {
      label: 'Doordrenken en laten opdrogen',
      text: 'Geef \'m een flinke plens — water tot het onderuit de pot loopt en geef daarna pas weer water als de aarde kurkdroog is (vaak pas na een week of twee). Een dagelijks scheutje laat vetplanten rotten; één grote slok en dan lang droog is precies wat ze willen.',
    },
  },
  fern: {
    en: {
      label: 'Keep evenly moist',
      text: 'Water little and often to keep the soil evenly moist — never let it dry out completely, but never leave it standing in water either. A thorough drink whenever the surface starts to feel dry is about right.',
    },
    nl: {
      label: 'Gelijkmatig vochtig houden',
      text: 'Geef kleine beetjes maar regelmatig, zodat de aarde gelijkmatig vochtig blijft — laat \'m nooit helemaal uitdrogen, maar laat \'m ook niet in het water staan. Een goede slok zodra de bovenkant droog begint te voelen is precies goed.',
    },
  },
  orchid: {
    en: {
      label: 'Soak the bark, then drain fully',
      text: 'Soak the bark thoroughly, then let every drop drain away — never leave water sitting in the pot or in the crown. It\'s a good drench and a full drain, not a daily trickle.',
    },
    nl: {
      label: 'Bast doorweken, dan laten uitlekken',
      text: 'Laat de bast goed doorweken en laat daarna elke druppel weglopen — laat nooit water in de pot of in het hart staan. Het is flink doorspoelen en volledig laten uitlekken, geen dagelijks straaltje.',
    },
  },
  herb: {
    en: {
      label: 'Keep moist — water generously',
      text: 'Herbs are thirsty — water generously whenever the surface starts to dry, until it drains from the bottom. Keep the soil consistently moist, but tip out any water left standing in the saucer.',
    },
    nl: {
      label: 'Vochtig houden — royaal water',
      text: 'Kruiden hebben dorst — geef royaal water zodra de bovenkant droog wordt, tot het onderuit de pot loopt. Houd de aarde gelijkmatig vochtig, maar giet water dat in de schotel blijft staan weg.',
    },
  },
  flowering: {
    en: {
      label: 'Soak the soil, drain, let the top dry',
      text: 'Water thoroughly until it drains from the bottom, aiming at the soil rather than the flowers or leaves. Let the top of the soil dry before the next drink and empty the saucer so the roots never sit in water.',
    },
    nl: {
      label: 'Aarde doordrenken, laten uitlekken',
      text: 'Water grondig tot het onderuit de pot loopt en richt op de aarde in plaats van op de bloemen of bladeren. Laat de bovenkant van de aarde uitdrogen voordat je opnieuw water geeft en giet de schotel leeg zodat de wortels nooit in water staan.',
    },
  },
  'tropical-foliage': {
    en: {
      label: 'Soak until it drains, then part-dry',
      text: 'Water thoroughly until it drains from the bottom, then let the top 2–3 cm dry before watering again. Empty the saucer so the roots never sit in water — a soak-then-dry beats frequent small splashes.',
    },
    nl: {
      label: 'Doordrenken, dan deels laten opdrogen',
      text: 'Water grondig tot het onderuit de pot loopt en laat daarna de bovenste 2–3 cm uitdrogen voor je opnieuw water geeft. Giet de schotel leeg zodat de wortels nooit in water staan — flink water en dan laten opdrogen werkt beter dan vaak kleine scheutjes.',
    },
  },
  other: {
    en: {
      label: 'Soak until it drains, then let the top dry',
      text: 'Water thoroughly until it just drains from the bottom, then let the top of the soil dry before the next drink. Tip out any water left standing in the saucer — sitting in water is the most common cause of root rot.',
    },
    nl: {
      label: 'Doordrenken, dan bovenkant laten opdrogen',
      text: 'Water grondig tot het net onderuit de pot loopt en laat daarna de bovenkant van de aarde uitdrogen voordat je opnieuw water geeft. Giet water dat in de schotel blijft staan weg — in water staan is de meest voorkomende oorzaak van wortelrot.',
    },
  },
};

// A pot with no drainage hole is the one case where the normal advice is not
// just imprecise but wrong: you can't "water until it drains" or "empty the
// saucer" when water has nowhere to go — it pools at the bottom and rots the
// roots. So when the plant is known to be in a no-drainage pot, this guidance
// overrides the type-based text with a safe measured-amount routine.
const WATER_NO_DRAINAGE = {
  en: {
    label: 'No drainage — add a little at a time, never let it pool',
    text: 'This pot has no drainage hole, so excess water can\'t escape — too much collects at the bottom and rots the roots. Add just a little at a time (roughly a third of the pot at most), let it soak in before adding more, and never leave water standing at the base. Tip the pot to the side to check, and move it to a pot with drainage when you can.',
  },
  nl: {
    label: 'Geen gaatje — beetje bij beetje, nooit laten staan',
    text: 'Deze pot heeft geen gat, dus overtollig water kan er niet uit — te veel blijft onderin staan en laat de wortels rotten. Geef steeds maar een beetje (hooguit ongeveer een derde van de pot), laat het intrekken voor je meer geeft en laat nooit water onderin staan. Kantel de pot om te checken, en zet \'m in een pot met een gat zodra dat kan.',
  },
};

export function wateringAmount(plant) {
  const nl = getLang() === 'nl';
  if (plant && plant.conditions && plant.conditions.drainage === 'no') {
    return WATER_NO_DRAINAGE[nl ? 'nl' : 'en'];
  }
  const cat = plantCategory(plant);
  const byLang = WATER_AMOUNT[cat] || WATER_AMOUNT.other;
  return byLang[nl ? 'nl' : 'en'];
}

// Pruning & repotting guidance — for "when the time gets there". Unlike watering,
// neither is on a fixed clock: pruning is mostly seasonal timing + plant type,
// and repotting is driven by growth (root-bound) + time, not pot size. The app
// can't see roots, so this PROMPTS the user at the right season and tells them
// what to look for, rather than claiming to know a plant needs it. Keyed by
// plant type for the technique, with a season-aware "is now a good time" nudge.

// The technique — what pruning/repotting looks like for this type of plant.
const PRUNE_BY_CAT = {
  'tropical-foliage': {
    en: 'Prune in early spring to shape it and keep its size in check — cut just above a leaf node. Trimming long, leggy vines keeps it full and bushy, and the cuttings will usually root in water.',
    nl: 'Snoei in het vroege voorjaar om \'m in vorm te houden en niet te groot te laten worden — knip net boven een bladknoop. Lange, kale ranken terugknippen houdt \'m vol en bossig, en de stekjes wortelen meestal zo in water.',
  },
  succulent: {
    en: 'Barely needs pruning — just remove any shrivelled, mushy or damaged leaves. If it\'s stretching and leggy, that\'s a cry for more light, not a haircut.',
    nl: 'Hoeft nauwelijks gesnoeid te worden — haal alleen verschrompelde, zachte of beschadigde blaadjes weg. Wordt hij lang en slierterig, dan wil hij meer licht, geen snoeibeurt.',
  },
  fern: {
    en: 'Don\'t prune it for shape — just snip brown or tired fronds off at the base. Fresh fronds keep unfurling from the centre.',
    nl: 'Niet snoeien voor de vorm — knip alleen bruine of uitgeputte bladeren bij de voet weg. Vanuit het hart komen steeds nieuwe bladeren.',
  },
  orchid: {
    en: 'Once the last flower drops, cut the spent flower spike back. Leave the leaves and healthy roots alone — save trimming any dead roots for repotting day.',
    nl: 'Als de laatste bloem is gevallen, knip je de uitgebloeide bloemstengel terug. Laat de bladeren en gezonde wortels met rust — dode wortels bijknippen doe je bij het verpotten.',
  },
  flowering: {
    en: 'Remove spent blooms as they fade to encourage more, and pinch back leggy stems after the main flush to keep it compact.',
    nl: 'Haal uitgebloeide bloemen weg zodra ze verwelken, dat stimuleert nieuwe. Knip kale stengels na de hoofdbloei terug om \'m compact te houden.',
  },
  herb: {
    en: 'Pinch and harvest the tips often — it keeps the plant bushy and delays bolting. Snip off any flower buds as soon as they appear to keep the leaves coming.',
    nl: 'Knijp en oogst de topjes vaak — dat houdt de plant bossig en stelt het doorschieten uit. Knip bloemknoppen weg zodra ze verschijnen, dan blijf je blad houden.',
  },
  other: {
    en: 'Prune lightly in early spring to shape it and remove dead or leggy growth — cut just above a node. Tidy away dead leaves whenever you spot them.',
    nl: 'Snoei licht in het vroege voorjaar om \'m in vorm te brengen en dode of kale groei weg te halen — knip net boven een knoop. Dode blaadjes mag je altijd weghalen.',
  },
};

const REPOT_BY_CAT = {
  'tropical-foliage': {
    en: 'Repot every 1–2 years, or sooner if roots circle the pot or poke out the drainage holes and water runs straight through. Move up just one pot size and refresh the soil.',
    nl: 'Verpot elke 1–2 jaar, of eerder als de wortels rond de pot draaien of onderuit de gaatjes komen en het water er zo doorheen loopt. Ga maar één maat groter en ververs de aarde.',
  },
  succulent: {
    en: 'A slow grower — repot only every 2–3 years or when it\'s clearly crowded. Use fresh gritty mix and keep the pot snug; an oversized pot stays wet and rots the roots.',
    nl: 'Een langzame groeier — verpot maar eens in de 2–3 jaar of als hij duidelijk te krap zit. Gebruik verse gritrijke aarde en houd de pot krap; een te grote pot blijft nat en laat de wortels rotten.',
  },
  fern: {
    en: 'Repot every 1–2 years once it fills the pot. Ferns like being a little snug and in fresh, moisture-retentive soil.',
    nl: 'Verpot elke 1–2 jaar zodra hij de pot vult. Varens houden van een beetje krap zitten en van verse, vochtvasthoudende aarde.',
  },
  orchid: {
    en: 'Repot every 1–2 years into fresh orchid bark (never regular soil), ideally just after flowering. Don\'t leave it sitting in old, broken-down, soggy bark.',
    nl: 'Verpot elke 1–2 jaar in verse orchideeënbast (nooit gewone potgrond), het liefst net na de bloei. Laat \'m niet in oude, afgebroken, natte bast zitten.',
  },
  flowering: {
    en: 'Repot every 1–2 years, or when it becomes root-bound. Go up only one pot size so the extra soil doesn\'t stay soggy.',
    nl: 'Verpot elke 1–2 jaar, of als hij te krap zit. Ga maar één maat groter zodat de extra aarde niet nat blijft staan.',
  },
  herb: {
    en: 'A fast grower — pot on whenever the roots fill the pot. Many herbs are happiest planted outdoors or simply replaced each season.',
    nl: 'Een snelle groeier — verpot zodra de wortels de pot vullen. Veel kruiden staan het liefst buiten of vervang je gewoon elk seizoen.',
  },
  other: {
    en: 'Repot every 1–2 years, or when roots start circling or growing out the drainage holes. Move up just one pot size and refresh the soil.',
    nl: 'Verpot elke 1–2 jaar, of als de wortels gaan draaien of uit de gaatjes groeien. Ga maar één maat groter en ververs de aarde.',
  },
};

// Is now a good time? — a short season-aware nudge appended to the technique.
const PRUNE_SEASON = {
  spring: { en: 'Right now, in spring, is a great time if it needs it.', nl: 'Nu, in de lente, is een prima moment als het nodig is.' },
  summer: { en: 'In summer keep it to light trims — save any hard pruning for early spring.', nl: 'Houd het in de zomer bij lichte snoei — bewaar flink snoeien voor het vroege voorjaar.' },
  autumn: { en: 'Heading into autumn, just tidy dead growth and hold bigger cuts until spring.', nl: 'Nu het herfst wordt: ruim alleen dood blad op en bewaar flink snoeien voor de lente.' },
  winter: { en: 'It\'s resting now, so avoid big cuts until late winter or early spring.', nl: 'Hij rust nu, dus wacht met flink snoeien tot het late voorjaar.' },
};

const REPOT_SEASON = {
  spring: { en: 'Spring is the ideal window, so if it\'s due, now\'s the time.', nl: 'De lente is hét moment, dus als het nodig is: nu doen.' },
  summer: { en: 'Early summer is still fine if it\'s clearly root-bound.', nl: 'De vroege zomer kan nog prima als hij duidelijk te krap zit.' },
  autumn: { en: 'Better to wait for spring now unless it\'s badly root-bound.', nl: 'Wacht liever tot de lente, tenzij hij echt te krap zit.' },
  winter: { en: 'Avoid repotting mid-winter — wait for spring unless it\'s urgent.', nl: 'Verpot niet midden in de winter — wacht op de lente, tenzij het dringend is.' },
};

// Roughly how often each type wants repotting — used to decide when a logged
// repot is old enough that it's worth checking for root-bound signs. Deliberately
// on the patient side so it prompts a *check*, never nags.
const REPOT_DUE_YEARS = { succulent: 3, herb: 1, orchid: 2, fern: 2, flowering: 2, 'tropical-foliage': 2, other: 2 };

// A friendly "how long ago" duration (no "ago"/"geleden" — the caller adds that).
function elapsedDuration(from, to, nl) {
  const days = Math.max(0, Math.floor((to - from) / 86400000));
  if (days < 10) return nl ? 'een paar dagen' : 'a few days';
  if (days < 25) return nl ? 'een paar weken' : 'a couple of weeks';
  const months = Math.round(days / 30.44);
  if (months < 12) return nl ? `ongeveer ${months} ${months === 1 ? 'maand' : 'maanden'}` : `about ${months} month${months === 1 ? '' : 's'}`;
  const years = Math.floor(days / 365.25);
  const rem = Math.round((days - years * 365.25) / 30.44);
  if (rem >= 11) return nl ? `bijna ${years + 1} jaar` : `almost ${years + 1} years`;
  if (rem <= 4) return nl ? `ongeveer ${years} jaar` : `about ${years} year${years > 1 ? 's' : ''}`;
  return nl ? `ruim ${years} jaar` : `over ${years} year${years > 1 ? 's' : ''}`;
}

// Pruning & repotting guidance. opts.lastPrune / opts.lastRepot (Date | null)
// make the text time-aware: repotting turns into a "check for root-bound signs"
// prompt once it's been longer than the type's usual interval.
export function pruningRepotTips(plant, settings, now = new Date(), opts = {}) {
  const nl = getLang() === 'nl';
  const lang = nl ? 'nl' : 'en';
  const cat = plantCategory(plant);
  const season = seasonForDate(now, settings.hemisphere);
  const { lastPrune = null, lastRepot = null } = opts;

  const pruneTech = (PRUNE_BY_CAT[cat] || PRUNE_BY_CAT.other)[lang];
  let pruneText;
  if (lastPrune) {
    const dur = elapsedDuration(lastPrune, now, nl);
    pruneText = nl
      ? `Je hebt 'm ${dur} geleden gesnoeid. ${pruneTech} ${PRUNE_SEASON[season].nl}`
      : `You last pruned it ${dur} ago. ${pruneTech} ${PRUNE_SEASON[season].en}`;
  } else {
    pruneText = `${pruneTech} ${PRUNE_SEASON[season][lang]}`;
  }

  const repotTech = (REPOT_BY_CAT[cat] || REPOT_BY_CAT.other)[lang];
  let repotText;
  if (lastRepot) {
    const dur = elapsedDuration(lastRepot, now, nl);
    const overdue = (now - lastRepot) / 86400000 / 365.25 >= (REPOT_DUE_YEARS[cat] ?? 2);
    if (overdue) {
      repotText = nl
        ? `Het is ${dur} geleden dat je 'm hebt verpot — een goed moment om te checken of de wortels rondcirkelen of onderuit de gaatjes groeien. Zo ja, ga één maat groter in verse aarde. ${REPOT_SEASON[season].nl}`
        : `It's been ${dur} since the last repot — worth checking now whether the roots are circling or growing out the drainage holes. If so, pot up just one size in fresh soil. ${REPOT_SEASON[season].en}`;
    } else {
      repotText = nl
        ? `Je hebt 'm ${dur} geleden verpot, dus hij zit voorlopig goed — let alleen op wortels die gaan cirkelen of onderuit komen.`
        : `You repotted it ${dur} ago, so it's settled in for now — just keep an eye out for roots circling or coming out the bottom.`;
    }
  } else {
    repotText = `${repotTech} ${REPOT_SEASON[season][lang]}`;
  }

  return [
    { icon: '✂️', kind: 'prune', text: pruneText },
    { icon: '🪴', kind: 'repot', text: repotText },
  ];
}

// Types that benefit from an annual spring shape-prune. Succulents, ferns and
// orchids are deliberately excluded — they're "remove dead growth only", so a
// "time to prune" nudge would be wrong advice for them.
const SPRING_PRUNE_CATS = new Set(['tropical-foliage', 'flowering', 'other']);

function repotIsDue(plant, now, lastRepot, cat) {
  const years = REPOT_DUE_YEARS[cat] ?? 2;
  // Fall back to how long we've known the plant when no repot was ever logged.
  const ref = lastRepot || (plant.acquiredDate ? new Date(plant.acquiredDate)
    : (plant.createdAt ? new Date(plant.createdAt) : null));
  if (!ref || isNaN(ref)) return false;
  return (now - ref) / 86400000 / 365.25 >= years;
}

function pruneIsDue(cat, now, lastPrune, plantAgeDays) {
  if (!SPRING_PRUNE_CATS.has(cat)) return false;
  if (lastPrune) return (now - lastPrune) / 86400000 >= 120; // not shaped in ~4 months
  return plantAgeDays >= 120;                                // never pruned, but established enough to
}

// Seasonal nudges — the "when the time gets there" trigger. Only fires in spring
// (the right window for both jobs) and only when the plant is actually due, so it
// prompts at most once a year per plant per job. Each nudge's body ends with a
// call to open the plant for the full how-to. Returns [] most of the year.
export function seasonalNudges(plant, settings, now = new Date(), opts = {}) {
  if (seasonForDate(now, settings.hemisphere) !== 'spring') return [];
  const nl = getLang() === 'nl';
  const cat = plantCategory(plant);
  const name = plant.name || (nl ? 'je plant' : 'your plant');
  const { lastPrune = null, lastRepot = null } = opts;
  const knownFrom = plant.acquiredDate ? new Date(plant.acquiredDate)
    : (plant.createdAt ? new Date(plant.createdAt) : now);
  const plantAgeDays = isNaN(knownFrom) ? 9999 : (now - knownFrom) / 86400000;
  const out = [];
  if (repotIsDue(plant, now, lastRepot, cat)) {
    out.push({
      kind: 'repot',
      title: nl ? `🪴 ${name} is misschien toe aan verpotten` : `🪴 ${name} may be due to repot`,
      body: nl
        ? `Het is lente — een goed moment om te checken of de wortels van ${name} uit de pot groeien. Tik voor uitleg.`
        : `It's spring — a good time to check whether ${name}'s roots have outgrown its pot. Tap for how.`,
    });
  }
  if (pruneIsDue(cat, now, lastPrune, plantAgeDays)) {
    out.push({
      kind: 'prune',
      title: nl ? `✂️ ${name} kan een lentesnoei gebruiken` : `✂️ ${name} could use a spring prune`,
      body: nl
        ? `In de lente snoei je ${name} in vorm en knip je kale groei terug. Tik voor uitleg.`
        : `Spring is the time to shape ${name} and cut back any leggy growth. Tap for how.`,
    });
  }
  return out;
}

// Flag a manually-entered schedule that's well outside the species' known-good
// range — a likely mistake — without ever forcing a change. Only applies when a
// species is known (custom plants have no reference to compare against).
// Threshold is deliberately lenient (2.5×) because real conditions vary a lot.
const OFF_RATIO = 2.5;

export function scheduleWarnings(profile, speciesId) {
  const s = speciesId ? getSpecies(speciesId) : null;
  if (!s) return [];
  const nl = getLang() === 'nl';
  const name = tl(s.name);
  const out = [];

  const w = Number(profile.water);
  if (w > 0 && s.water) {
    if (w <= s.water / OFF_RATIO) {
      out.push({
        field: 'water', recommended: s.water,
        message: nl
          ? `Je ${name} wil meestal ongeveer elke ${s.water} dagen water — elke ${w} is misschien te vaak, en te veel water geven is de meest voorkomende doodsoorzaak van kamerplanten.`
          : `Your ${s.name} usually prefers watering about every ${s.water} days — every ${w} may be too often, and overwatering is the most common way houseplants die.`,
      });
    } else if (w >= s.water * OFF_RATIO) {
      out.push({
        field: 'water', recommended: s.water,
        message: nl
          ? `Je ${name} houdt meestal van water ongeveer elke ${s.water} dagen — elke ${w} kan 'm te ver laten uitdrogen.`
          : `Your ${s.name} usually likes water about every ${s.water} days — every ${w} could let it dry out too much.`,
      });
    }
  }

  const f = Number(profile.fertilize);
  if (f > 0 && s.fertilize && f <= s.fertilize / OFF_RATIO) {
    out.push({
      field: 'fertilize', recommended: s.fertilize,
      message: nl
        ? `Elke ${f} dagen voeden is veel voor je ${name} (die wil meestal ongeveer elke ${s.fertilize}); te veel voeden kan de wortels verbranden.`
        : `Feeding every ${f} days is a lot for your ${s.name} (it usually wants about every ${s.fertilize}); over-feeding can burn the roots.`,
    });
  }

  return out;
}
