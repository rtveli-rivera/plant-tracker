// Regenerates the Android launcher icons from the app's SVG art.
//
// Rasterizes three 1024² layers into assets/ (the input @capacitor/assets
// expects), then runs the generator to emit every mipmap density + the adaptive
// icon XML into android/app/src/main/res. Re-run after changing the icon art.
import sharp from 'sharp';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const assets = join(root, 'assets');
const src = join(assets, 'src');
const S = 1024;

mkdirSync(assets, { recursive: true });

console.log('Rasterizing icon layers…');
await Promise.all([
  // Full square icon (rounded card + plant) for legacy launchers.
  sharp(join(root, 'icons', 'icon.svg')).resize(S, S).png().toFile(join(assets, 'icon-only.png')),
  // Adaptive foreground (plant, transparent) + background (green card).
  sharp(join(src, 'foreground.svg')).resize(S, S).png().toFile(join(assets, 'icon-foreground.png')),
  sharp(join(src, 'background.svg')).resize(S, S).png().toFile(join(assets, 'icon-background.png')),
]);

console.log('Generating Android launcher icons…');
const res = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['@capacitor/assets', 'generate', '--android'],
  { cwd: root, stdio: 'inherit' },
);
process.exit(res.status || 0);
