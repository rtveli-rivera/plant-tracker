// util.js — Small shared helpers (DOM, dates, photos).

// Tiny DOM helper: el('div', {class:'x'}, [children | 'text'])
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'value') node.value = v;
    else node.setAttribute(k, v);
  }
  const kids = Array.isArray(children) ? children : [children];
  for (const c of kids) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---- Dates --------------------------------------------------------------

const pad2 = (n) => String(n).padStart(2, '0');

// Format an instant as a LOCAL "YYYY-MM-DD" (for <input type=date>).
export function toDateInputValue(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${pad2(x.getMonth() + 1)}-${pad2(x.getDate())}`;
}

export function todayISO() {
  return toDateInputValue(new Date());
}

// Turn a date-input string ("YYYY-MM-DD") into a stored ISO at LOCAL noon.
// Anchoring at noon keeps the calendar day stable across time zones and DST,
// so schedules never drift by a day. Pass-through if already a full ISO.
export function dateInputToISO(str) {
  if (!str) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (!m) return new Date(str).toISOString();
  return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0).toISOString();
}

// Locale for dates and relative-time words. Set by the app from the language
// setting (keeps util dependency-free — it doesn't import settings itself).
let LOCALE = 'en';
export function setLocale(l) { LOCALE = l === 'nl' ? 'nl' : 'en'; }

export function fmtDate(d) {
  const date = new Date(d);
  return date.toLocaleDateString(LOCALE === 'nl' ? 'nl-NL' : undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fmtRelative(days) {
  if (LOCALE === 'nl') {
    if (days === 0) return 'vandaag';
    if (days === 1) return 'morgen';
    if (days === -1) return 'gisteren';
    if (days < 0) return `${-days} dagen geleden`;
    return `over ${days} dagen`;
  }
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  if (days < 0) return `${-days} days ago`;
  return `in ${days} days`;
}

// ---- Photos -------------------------------------------------------------

// Read a File, downscale it, and return a compact JPEG data URL so photos
// don't bloat IndexedDB. maxDim caps the longest edge.
export function fileToResizedDataURL(file, maxDim = 900, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Convert a (JPEG) data URL to a PNG Blob — needed to put an image on the
// clipboard (the Clipboard API only reliably accepts image/png).
export function dataUrlToPngBlob(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('blob failed'))), 'image/png');
    };
    img.onerror = () => reject(new Error('image load failed'));
    img.src = dataUrl;
  });
}

export function download(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
