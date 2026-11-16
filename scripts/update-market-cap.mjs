import { readFile, writeFile } from 'node:fs/promises';
import { fetchNasdaqTop100, parseNasdaqScreener } from './market-cap-source.mjs';

const output = new URL('../market-cap-top100.json', import.meta.url);
const fixture = process.argv[2];
const { asOf, rows } = fixture
  ? parseNasdaqScreener(JSON.parse((await readFile(fixture, 'utf8')).replace(/^﻿/, '')))
  : await fetchNasdaqTop100();

let previous;
try {
  previous = JSON.parse(await readFile(output, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (previous?.asOf > asOf) throw new Error('Nasdaq returned an older market date.');
await writeFile(output, JSON.stringify({ asOf, rows }, null, 2) + '\n');
console.log('Nasdaq market date', asOf, 'listings', rows.length);
