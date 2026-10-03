#!/usr/bin/env node
/**
 * scripts/build.mjs — кроссплатформенная обёртка над `next build --webpack`.
 *
 * Почему: сборка этого проекта не помещается в хип Node по умолчанию
 * (~4 ГБ) и падает с `FATAL ERROR: JavaScript heap out of memory`.
 * При увеличенном хипе (8 ГБ) сборка проходит штатно (проверено).
 *
 * Как: NODE_OPTIONS читается только в момент СТАРТА node-процесса, поэтому
 * мы запускаем `next build` отдельным дочерним процессом, у которого этот
 * флаг уже задан в окружении (рабочие потоки webpack — потоки того же
 * процесса — делят с ним хип). Никаких новых зависимостей не требуется.
 *
 * Переопределить размер хипа (в МБ):
 *   NEXT_BUILD_HEAP_MB=12288 npm run build
 *
 * Вернуться к сборке без обёртки (хип по умолчанию):
 *   npm run build:default
 */
import { spawnSync } from 'node:child_process';

const heapMb = Number(process.env.NEXT_BUILD_HEAP_MB) || 8192;
const flag = `--max-old-space-size=${heapMb}`;
const prev = (process.env.NODE_OPTIONS || '').trim();
const env = { ...process.env, NODE_OPTIONS: prev ? `${prev} ${flag}` : flag };

console.log(`[build] next build --webpack  (heap = ${heapMb} MB)`);
const r = spawnSync('npx', ['next', 'build', '--webpack'], {
  env,
  stdio: 'inherit',
  // На Windows npx это npx.cmd — нужен shell, чтобы он резолвился.
  shell: process.platform === 'win32',
});

if (r.error) {
  console.error('[build] не удалось запустить next build:', r.error.message);
  process.exit(1);
}
process.exit(r.status == null ? 1 : r.status);
