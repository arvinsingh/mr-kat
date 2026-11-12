// Resolve environment and relative data paths from the project root on any host.
import { existsSync } from 'node:fs';
import { setDefaultResultOrder } from 'node:dns';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from 'node:process';

setDefaultResultOrder('ipv4first');

const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 13)
  throw new Error(`Mr. Kat requires Node.js 24.13+ within 24.x; found ${process.versions.node}.`);

process.chdir(dirname(fileURLToPath(import.meta.url)));
if (existsSync('.env')) loadEnvFile('.env');
const entry = resolve('dist/src/index.js');
if (!existsSync(entry)) throw new Error('Compiled bot files are missing. Run npm run build first.');
await import(pathToFileURL(entry).href);
