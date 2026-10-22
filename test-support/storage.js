import Database from 'better-sqlite3';
import { resolve } from 'node:path';

export function blockWrites(t, cwd) {
  const database = new Database(resolve(cwd, 'data/forms.sqlite'));
  database.exec('BEGIN IMMEDIATE');
  const release = () => {
    if (database.open) {
      database.exec('ROLLBACK');
      database.close();
    }
  };
  t.after(release);
  return release;
}
