import { getDb } from './db.js';

export function setupDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS matches (
      match_id INTEGER PRIMARY KEY,
      sport TEXT DEFAULT 'football',
      date TEXT,
      status TEXT,
      home_team_id INTEGER,
      away_team_id INTEGER,
      home_team TEXT,
      away_team TEXT,
      home_goals INTEGER,
      away_goals INTEGER
    );

    CREATE TABLE IF NOT EXISTS stats (
      match_id INTEGER PRIMARY KEY,
      sport TEXT DEFAULT 'football',
      home_form REAL,
      away_form REAL,
      home_goals_avg REAL,
      away_goals_avg REAL,
      FOREIGN KEY (match_id) REFERENCES matches (match_id)
    );
  `);

  ensureColumn(db, 'matches', 'status', 'TEXT');
  ensureColumn(db, 'matches', 'home_team_id', 'INTEGER');
  ensureColumn(db, 'matches', 'away_team_id', 'INTEGER');
  ensureColumn(db, 'matches', 'sport', 'TEXT');
  ensureColumn(db, 'stats', 'sport', 'TEXT');

  db.exec(`
    UPDATE matches SET sport = 'football' WHERE sport IS NULL;
    UPDATE stats SET sport = 'football' WHERE sport IS NULL;
  `);
}

function ensureColumn(db, tableName, columnName, columnType) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some((col) => col.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  }
}
