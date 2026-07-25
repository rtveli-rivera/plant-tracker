// Builds the debug APK via Gradle and reports where it landed. Run after the web
// assets have been synced (npm run build:apk does sync-web + cap sync first).
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const android = join(root, 'android');
const gradlew = process.platform === 'win32' ? '.\\gradlew.bat' : './gradlew';

console.log('Building debug APK (Gradle)…');
const res = spawnSync(gradlew, ['assembleDebug'], { cwd: android, stdio: 'inherit', shell: true });
if (res.status !== 0) {
  console.error(`\nGradle build failed (exit ${res.status}).`);
  process.exit(res.status || 1);
}
const apk = join(android, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
console.log(existsSync(apk)
  ? `\n✅ APK built:\n   ${apk}`
  : '\n⚠️ Build finished but APK not found at the expected path.');
