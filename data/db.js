import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export const DB_PATH = path.resolve('data', 'database.db');

let dbInstance = null;

export function getDb() {
  if (!dbInstance) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    dbInstance = new Database(DB_PATH);
    dbInstance.pragma('journal_mode = WAL');
  }
  return dbInstance;
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
