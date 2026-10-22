import Database from 'better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

mkdirSync(resolve('data'), { recursive: true, mode: 0o700 });
const path = resolve('data/forms.sqlite');
export const database = new Database(path, { timeout: 1000 });
chmodSync(path, 0o600);
database.pragma('foreign_keys = ON');
database.transaction(() => database.exec(`
  CREATE TABLE IF NOT EXISTS forms (
    id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    fields TEXT NOT NULL CHECK (json_valid(fields)),
    status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'closed')),
    publicUrl TEXT UNIQUE,
    CHECK ((status = 'draft' AND publicUrl IS NULL) OR (status != 'draft' AND publicUrl IS NOT NULL))
  );
  CREATE TABLE IF NOT EXISTS attempts (
    id TEXT PRIMARY KEY NOT NULL,
    formId TEXT NOT NULL REFERENCES forms(id),
    createdAt TEXT NOT NULL,
    startedAt TEXT,
    lastActiveAt TEXT NOT NULL,
    lastFieldId TEXT,
    UNIQUE (id, formId)
  );
  CREATE TABLE IF NOT EXISTS responses (
    id TEXT PRIMARY KEY NOT NULL,
    formId TEXT NOT NULL REFERENCES forms(id),
    attemptId TEXT UNIQUE,
    submittedAt TEXT NOT NULL,
    catalogVersion TEXT NOT NULL,
    answers TEXT NOT NULL CHECK (json_valid(answers)),
    FOREIGN KEY (attemptId, formId) REFERENCES attempts(id, formId)
  );
  CREATE INDEX IF NOT EXISTS attempts_form ON attempts(formId);
  CREATE INDEX IF NOT EXISTS responses_form ON responses(formId);
`)).immediate();

/** @param {unknown} row @returns {import('./server.js').Form} */
export function readForm(row) {
  const form = /** @type {Omit<import('./server.js').Form, 'fields'> & {fields: string}} */ (row);
  return { ...form, fields: JSON.parse(form.fields) };
}

/** @param {unknown} row @returns {import('./server.js').FormResponse} */
export function readResponse(row) {
  const response = /** @type {Omit<import('./server.js').FormResponse, 'answers' | 'attemptId'> & {answers: string, attemptId: string | null}} */ (row);
  const { attemptId, ...rest } = response;
  return { ...rest, ...(attemptId === null ? {} : { attemptId }), answers: JSON.parse(response.answers) };
}
