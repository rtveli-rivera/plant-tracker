// refphoto.js — Fetch a "what a healthy one looks like" reference photo for a
// species from Wikipedia, once, and keep it on-device.
//
// Design: nothing is bundled with the app (27 species × photos would triple the
// download and raise licensing questions). Instead we ask Wikipedia's REST API
// for the species article's lead image the first time a plant's page is opened
// while online, then store the small thumbnail (~20–50 KB) on the plant record
// in IndexedDB. Offline-first stays intact: no photo is ever required, and we
// link back to the source article for attribution.

const SUMMARY_URL = (title) => `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
const SEARCH_URL = (q) => `https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&origin=*&search=${encodeURIComponent(q)}`;

async function summaryFor(title) {
  const res = await fetch(SUMMARY_URL(title), { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const data = await res.json();
  // Disambiguation pages have no useful single image.
  if (!data || data.type === 'disambiguation' || !data.thumbnail || !data.thumbnail.source) return null;
  return data;
}

async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

// Try each candidate name in order (latin first — species articles resolve most
// reliably by scientific name), then one search-assisted attempt. Returns
// { dataUrl, pageTitle, pageUrl } or null. Never throws.
export async function fetchSpeciesImage(candidates) {
  const names = (candidates || []).filter((n) => n && !/^various$/i.test(n));
  try {
    let summary = null;
    for (const name of names.slice(0, 2)) {
      summary = await summaryFor(name);
      if (summary) break;
    }
    if (!summary && names.length) {
      // Direct titles missed — let Wikipedia's search resolve the name once.
      const res = await fetch(SEARCH_URL(names[0]));
      if (res.ok) {
        const [, titles] = await res.json();
        if (titles && titles[0]) summary = await summaryFor(titles[0]);
      }
    }
    if (!summary) return null;
    const imgRes = await fetch(summary.thumbnail.source);
    if (!imgRes.ok) return null;
    const dataUrl = await blobToDataUrl(await imgRes.blob());
    return {
      dataUrl,
      pageTitle: summary.title,
      pageUrl: (summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page) || `https://en.wikipedia.org/wiki/${encodeURIComponent(summary.title)}`,
      fetchedAt: new Date().toISOString(),
    };
  } catch {
    return null; // offline / blocked / malformed — the app simply shows no reference
  }
}
