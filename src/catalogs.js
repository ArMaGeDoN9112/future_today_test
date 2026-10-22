import { readFileSync } from 'node:fs';

export const catalogVersion = '2026-10-22';
/** @typedef {'cities' | 'universities'} CatalogKind */
/** @typedef {{id: string, name: string, region?: string}} CatalogEntry */
/** @type {{version: string, cities: CatalogEntry[], universities: CatalogEntry[]}} */
const snapshot = JSON.parse(readFileSync(new URL(`../catalogs/snapshots/${catalogVersion}.json`, import.meta.url), 'utf8'));
if (snapshot.version !== catalogVersion) throw new Error('Версия справочника не совпадает.');

/** @param {CatalogKind} kind */
function index(kind) {
  const entries = snapshot[kind];
  if (!Array.isArray(entries) || !entries.length) throw new Error(`Пустой справочник ${kind}.`);
  /** @type {Map<string, Readonly<CatalogEntry>>} */
  const result = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() ||
        typeof entry.name !== 'string' || !entry.name.trim() || result.has(entry.id) ||
        (kind === 'cities' && (typeof entry.region !== 'string' || !entry.region.trim()))) {
      throw new Error(`Некорректная запись справочника ${kind}.`);
    }
    result.set(entry.id, Object.freeze(entry));
  }
  return result;
}

const catalogs = { cities: index('cities'), universities: index('universities') };

/** @param {string} value */
function normalize(value) {
  return value.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

/** @param {CatalogKind} kind @param {string} query */
export function searchCatalog(kind, query) {
  const needle = normalize(query);
  return [...catalogs[kind].values()].filter(entry => normalize(entry.name).includes(needle));
}

/** @param {CatalogKind} kind @param {string} id */
export function getCatalogEntry(kind, id) {
  return catalogs[kind].get(id);
}
