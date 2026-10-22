import { readFileSync } from 'node:fs';

export const catalogVersion = '2026-10-22';
/** @typedef {'bachelor' | 'master' | 'specialist'} StudyLevel */
/** @typedef {'cities' | 'universities' | 'study-directions' | 'study-courses'} CatalogKind */
/** @typedef {{id: string, name: string, region?: string, code?: string, level?: StudyLevel, course?: string}} CatalogEntry */
/** @type {{version: string} & Record<CatalogKind, CatalogEntry[]>} */
const snapshot = JSON.parse(readFileSync(new URL(`../catalogs/snapshots/${catalogVersion}.json`, import.meta.url), 'utf8'));
if (snapshot.version !== catalogVersion) throw new Error('Версия справочника не совпадает.');
const studySnapshot = JSON.parse(readFileSync(new URL(`../catalogs/snapshots/${catalogVersion}-study.json`, import.meta.url), 'utf8'));
if (studySnapshot.version !== catalogVersion) throw new Error('Версия справочника направлений не совпадает.');
snapshot['study-directions'] = studySnapshot['study-directions'];
snapshot['study-courses'] = studySnapshot['study-courses'];

/** @param {CatalogKind} kind */
function index(kind) {
  const entries = snapshot[kind];
  if (!Array.isArray(entries) || !entries.length) throw new Error(`Пустой справочник ${kind}.`);
  /** @type {Map<string, Readonly<CatalogEntry>>} */
  const result = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || !entry.id.trim() ||
        typeof entry.name !== 'string' || !entry.name.trim() || result.has(entry.id) ||
        (kind === 'cities' && (typeof entry.region !== 'string' || !entry.region.trim())) ||
        (kind === 'study-directions' && (typeof entry.code !== 'string' ||
          !/^\d{2}\.(03|04|05)\.\d{2}$/.test(entry.code) ||
          entry.level !== ({ '03': 'bachelor', '04': 'master', '05': 'specialist' }[entry.code.split('.')[1]]))) ||
        (kind === 'study-courses' && (!['bachelor', 'master', 'specialist'].includes(entry.level ?? '') ||
          typeof entry.course !== 'string' || !/^[1-5]\+?$/.test(entry.course)))) {
      throw new Error(`Некорректная запись справочника ${kind}.`);
    }
    result.set(entry.id, Object.freeze(entry));
  }
  return result;
}

const catalogs = {
  cities: index('cities'), universities: index('universities'),
  'study-directions': index('study-directions'), 'study-courses': index('study-courses'),
};

/** @param {string} value */
function normalize(value) {
  return value.trim().toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

/** @param {CatalogKind} kind @param {string} query @param {StudyLevel} [level] */
export function searchCatalog(kind, query, level) {
  const needle = normalize(query);
  return [...catalogs[kind].values()].filter(entry =>
    (!level || entry.level === level) && (normalize(entry.name).includes(needle) || entry.code?.includes(needle)));
}

/** @param {CatalogKind} kind @param {string} id */
export function getCatalogEntry(kind, id) {
  return catalogs[kind].get(id);
}
