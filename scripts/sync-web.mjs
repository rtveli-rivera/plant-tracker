// Copies the static PWA assets into ./www so Capacitor can bundle them into the
// native app. The web app source stays exactly where it is — this only mirrors a
// whitelist of runtime files into a throwaway build folder (www/ is gitignored).
//
// Note: sw.js is intentionally NOT copied. Inside the native WebView the app is
// already served locally, so the offline service worker adds nothing and its
// shell-caching would fight app updates. Notifications come from the native
// LocalNotifications plugin, not the SW. app.js skips SW registration on native.
import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const www = join(root, 'www');

// Runtime assets the app actually loads in the browser.
const INCLUDE = ['index.html', 'manifest.webmanifest', 'css', 'js', 'icons'];

if (existsSync(www)) rmSync(www, { recursive: true, force: true });
mkdirSync(www, { recursive: true });

for (const item of INCLUDE) {
  const src = join(root, item);
  if (existsSync(src)) {
    cpSync(src, join(www, item), { recursive: true });
    console.log(`  copied ${item}`);
  } else {
    console.warn(`  (skipped missing ${item})`);
  }
}
console.log('Web assets synced to www/');
