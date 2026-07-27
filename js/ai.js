// ai.js — AI plant health analysis via Claude's vision model.
//
// Sends a plant photo to the Anthropic Messages API and gets back a warm,
// human-sounding read on the plant's health plus concrete next steps.
//
// Privacy note: this is the ONE feature that leaves the device. The photo and a
// short prompt are sent to Anthropic's API using the user's own API key (stored
// locally). Everything else in the app stays on-device.

import { getSettings } from './settings.js';
import { getLang, getUnits } from './i18n.js';

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

export const AI_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — best analysis' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5 — balanced' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fastest & cheapest' },
];

export class AIError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function hasApiKey() {
  return !!(getSettings().apiKey || '').trim();
}

// The shape we ask Claude to return, so the UI can render it nicely and
// optionally save a health-log entry from it.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    is_plant: { type: 'boolean' },
    species_guess: { type: 'string' },
    condition: { type: 'string', enum: ['good', 'ok', 'poor'] },
    headline: { type: 'string' },
    assessment: { type: 'string' },
    observations: { type: 'array', items: { type: 'string' } },
    next_steps: { type: 'array', items: { type: 'string' } },
    watch_for: { type: 'array', items: { type: 'string' } },
    // Concrete, one-tap-applyable schedule tweaks.
    adjustments: {
      type: 'object',
      additionalProperties: false,
      properties: {
        recommend_watering_change: { type: 'boolean' },
        water_interval_days: { type: 'integer' },      // new growing-season baseline
        recommend_feeding_change: { type: 'boolean' },
        fertilize_interval_days: { type: 'integer' },  // new growing-season baseline
        water_now: { type: 'boolean' },                // looks thirsty; water today
        summary: { type: 'string' },                   // one line explaining the tweak
      },
      required: [
        'recommend_watering_change', 'water_interval_days',
        'recommend_feeding_change', 'fertilize_interval_days',
        'water_now', 'summary',
      ],
    },
  },
  // All required (empty arrays / strings when N/A) for strict schema validation.
  required: [
    'is_plant', 'species_guess', 'condition', 'headline', 'assessment',
    'observations', 'next_steps', 'watch_for', 'adjustments',
  ],
};

const SYSTEM_PROMPT = `You are a warm, plain-spoken houseplant expert helping someone care for their plants — like a knowledgeable friend, not a textbook.

You will be shown a photo of a houseplant and told the current season. Assess the plant's visible health and give practical, encouraging, honest advice.

Voice and style:
- Talk like a real person. Second person ("your plant", "you'll want to..."). Warm and reassuring, but honest if something looks off.
- Be specific about what you actually see in the photo — leaf color, drooping, spots, new growth, soil, the pot.
- If the owner gives background (recent repotting, a move, a change in light or watering, symptoms and when they started), treat it as key evidence — it can change your diagnosis. Acknowledge it and connect your assessment to it.
- You may also get the owner's care records from the app: when it was last watered and fed, the pot size/material and drainage, the light at its spot, recent health notes, and recent repotting/pruning. Treat these like a patient's chart and weigh them together with the photo — the same symptom flips diagnosis on this evidence. Drooping two days after a thorough watering points to overwatering or poor drainage, not thirst; drooping at day 12 of a 7-day interval points to underwatering. A pot with no drainage makes root rot the prime suspect.
- If the photo and records are genuinely ambiguous, say so and make your first next_step the check that disambiguates (e.g. "feel 3 cm into the soil: wet = hold off, dry = water"). If the photo is too far away or blurry to judge leaves or pests, say that in the assessment and ask for a closer shot in watch_for.
- If it's a new/healthy plant, celebrate it ("great pick", "looking really healthy").
- Keep it concise. No markdown, no headings, no emoji in your text fields.

Fill every field of the JSON:
- is_plant: false if the image clearly isn't a houseplant; then put a friendly one-line explanation in "assessment" and leave the plant fields generic.
- condition: your honest overall read — "good", "ok", or "poor".
- headline: a short, friendly one-liner (e.g. "Looking healthy — nice choice!" or "A bit thirsty, but easily fixed").
- assessment: 2–4 conversational sentences on how it looks and why.
- observations: specific things you notice (can be empty).
- next_steps: 2–5 concrete actions, ordered by what matters most. Favor not-overwatering; overwatering is the most common killer.
- watch_for: early-warning signs to keep an eye on (empty array if none).
- species_guess: your best guess at the species/common name (empty string if unsure).
- adjustments: concrete tweaks the app can apply in one tap. You'll be told the current growing-season watering and feeding intervals.
  - recommend_watering_change: true ONLY if the evidence (photo + records) clearly suggests the current watering interval is wrong (e.g. yellow soft leaves + wet soil = water less often; crispy/drooping + dry = more often). Be conservative — most healthy plants need no change.
  - water_interval_days: the growing-season baseline you'd set (echo the current value when recommend_watering_change is false). Must be 1–60 days, and stay within half-to-double the current interval unless the plant is clearly in crisis.
  - recommend_feeding_change / fertilize_interval_days: same idea for feeding (echo current when no change). Must be 7–120 days, or 0 to stop scheduled feeding.
  - water_now: true only if it looks thirsty right now and should be watered today — never when the records show it was watered in the last couple of days.
  - summary: one short sentence describing the tweak, or "No schedule changes needed." if nothing changes.`;

// Language + units instructions, appended to the health-check system prompt at
// call time (settings can change between calls). Species data is NOT localized —
// those fields are canonical English that the app translates at display time.
function localeLines() {
  const lines = [];
  if (getLang() === 'nl') {
    lines.push('Write every text-field VALUE (headline, assessment, observations, next_steps, watch_for, species_guess, adjustments.summary) in natural, warm, informal Dutch (je/jij) — written natively, not translated word-for-word. Keep the JSON keys and the condition enum ("good"/"ok"/"poor") in English.');
  }
  lines.push(getUnits() === 'imperial'
    ? 'When you mention sizes, depths or temperatures, use imperial units (inches, °F).'
    : 'When you mention sizes, depths or temperatures, use metric units (cm, °C).');
  return lines.join('\n');
}

function splitDataUrl(dataUrl) {
  const m = /^data:(image\/[a-zA-Z+]+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) throw new AIError('bad-image', 'That image could not be read. Try another photo.');
  return { mediaType: m[1], base64: m[2] };
}

// Shared Claude call: sends a structured-output request and returns parsed JSON.
async function callAnthropic({ system, content, schema, maxTokens = 1024 }) {
  const settings = getSettings();
  const apiKey = (settings.apiKey || '').trim();
  if (!apiKey) {
    throw new AIError('no-key', 'Add your Anthropic API key in Settings to use AI features.');
  }
  const model = settings.aiModel || 'claude-opus-4-8';
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    // Low temperature: this is a diagnostic task — the same photo + records
    // should produce the same read and the same schedule advice run-to-run.
    temperature: 0.3,
    messages: [{ role: 'user', content }],
    output_config: { format: { type: 'json_schema', schema } },
  };

  let res;
  try {
    res = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        // Required to allow calling the API directly from a browser.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new AIError('network', 'Could not reach the AI service. Check your internet connection and try again.');
  }

  if (!res.ok) {
    let detail = '';
    try {
      const err = await res.json();
      detail = err?.error?.message || '';
    } catch { /* ignore */ }
    if (res.status === 401) throw new AIError('auth', 'That API key was rejected. Double-check it in Settings.');
    if (res.status === 403) throw new AIError('auth', 'This API key doesn’t have access. Check your Anthropic plan or key permissions.');
    if (res.status === 429) throw new AIError('rate', 'Rate limit hit — wait a moment and try again.');
    if (res.status === 400) throw new AIError('bad-request', detail || 'The request was rejected. Please try again.');
    if (res.status >= 500) throw new AIError('server', 'The AI service is having trouble right now. Try again shortly.');
    throw new AIError('http', detail || `Request failed (${res.status}).`);
  }

  const data = await res.json();
  if (data.stop_reason === 'refusal') {
    throw new AIError('refusal', 'The AI declined this request. Please try again.');
  }
  const textBlock = (data.content || []).find((b) => b.type === 'text');
  if (!textBlock || !textBlock.text) {
    throw new AIError('empty', 'The AI didn’t return a result. Please try again.');
  }
  try {
    return JSON.parse(textBlock.text);
  } catch {
    throw new AIError('parse', 'Got an unexpected response from the AI. Please try again.');
  }
}

// Analyze a plant photo. `context` may include plantName, speciesName, season,
// waterBase/feedBase, background (owner's free text) and record (an array of
// care-record lines from the app: last watered/fed, pot & drainage, health notes…).
export async function analyzePlant(dataUrl, context = {}) {
  const { mediaType, base64 } = splitDataUrl(dataUrl);

  const bits = [];
  if (context.plantName) bits.push(`I call it "${context.plantName}".`);
  if (context.speciesName) bits.push(`I've noted it as a ${context.speciesName}.`);
  if (context.season) bits.push(`It's currently ${context.season} where I am.`);
  if (Number.isFinite(context.waterBase)) {
    bits.push(`My current routine waters it every ${context.waterBase} days (growing-season baseline).`);
  }
  if (Number.isFinite(context.feedBase) && context.feedBase > 0) {
    bits.push(`I feed it every ${context.feedBase} days.`);
  }
  const record = (Array.isArray(context.record) && context.record.length)
    ? `\n\nMy care records from the app:\n${context.record.map((r) => `- ${r}`).join('\n')}`
    : '';
  const bg = (context.background || '').trim();
  const bgLine = bg ? `\n\nImportant background from me (weigh this heavily — it may change your read): ${bg}` : '';
  const userText =
    `Here's a photo of my houseplant. ${bits.join(' ')}${record}${bgLine}\n\nHow does it look, and what should I do to keep it healthy?`.trim();

  return callAnthropic({
    system: `${SYSTEM_PROMPT}\n\n${localeLines()}`,
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
      { type: 'text', text: userText },
    ],
    schema: SCHEMA,
    maxTokens: 1024,
  });
}

// ---- Species care lookup ------------------------------------------------

// Care data for a species not in the built-in library. Shape mirrors the
// editable plant profile so results drop straight into the Add form.
const CARE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matched: { type: 'boolean' },
    common_name: { type: 'string' },
    latin_name: { type: 'string' },
    category: { type: 'string', enum: ['succulent', 'tropical-foliage', 'fern', 'orchid', 'flowering', 'herb', 'other'] },
    water_interval_days: { type: 'integer' },   // growing-season baseline
    winter_factor: { type: 'number' },          // multiply interval by this in winter (1.2–3.0)
    fertilize_interval_days: { type: 'integer' },
    feed_winter: { type: 'boolean' },
    light: { type: 'string', enum: ['low', 'medium', 'bright', 'full'] },
    humidity: { type: 'string' },
    temp_min_c: { type: 'integer' },
    toxicity: { type: 'string' },
    difficulty: { type: 'string', enum: ['easy', 'moderate', 'hard'] },
    soil: { type: 'string' },
    tips: { type: 'string' },
    note: { type: 'string' },
  },
  required: [
    'matched', 'common_name', 'latin_name', 'category', 'water_interval_days',
    'winter_factor', 'fertilize_interval_days', 'feed_winter', 'light', 'humidity',
    'temp_min_c', 'toxicity', 'difficulty', 'soil', 'tips', 'note',
  ],
};

const CARE_SYSTEM = `You are an accurate houseplant care database. Given a plant name (and optionally a photo), return baseline INDOOR care data for an average potted specimen. Be accurate and conservative; if you don't recognize a real plant, set matched=false and explain briefly in "note".

Field meanings:
- water_interval_days: typical days between waterings in the GROWING SEASON for an average indoor pot.
- winter_factor: multiply that interval by this during winter dormancy. Roughly 1.2 for tropicals in warm homes, 1.6 for typical foliage, 2.0 for succulents, up to 3.0 for cacti.
- fertilize_interval_days: days between feedings in the growing season (use 0 if it's rarely fed).
- feed_winter: whether to keep feeding through winter (usually false).
- light: one of low, medium (bright indirect), bright (bright indirect + some direct), full (full sun).
- humidity: short phrase (e.g. "Average", "High", "Low").
- temp_min_c: minimum safe temperature in Celsius.
- toxicity: short phrase (e.g. "Toxic to pets", "Pet safe").
- difficulty: easy, moderate, or hard.
- soil: short recommended soil/mix.
- tips: 1–2 sentences with the single most important care tip and the most common mistake.
- common_name / latin_name: fill both if known.

Write ALL string field values in English regardless of the user's language — the app stores them canonically and translates for display.`;

// Fetch baseline care data for a species by name (photo optional to help ID).
export async function lookupSpeciesCare(name, photoDataUrl = null) {
  const content = [];
  if (photoDataUrl) {
    const { mediaType, base64 } = splitDataUrl(photoDataUrl);
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
  }
  content.push({ type: 'text', text: `Plant: ${name || 'the plant in the photo'}.\nReturn baseline indoor care data for this species.` });
  return callAnthropic({ system: CARE_SYSTEM, content, schema: CARE_SCHEMA, maxTokens: 800 });
}
