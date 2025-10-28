import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setupDatabase } from './data/dbSetup.js';
import { DB_PATH } from './data/db.js';
import { fetchMatches } from './api/apiHandler.js';
import { calculateFeatures } from './features/featureEngine.js';
import { predictMatch } from './ai/predictor.js';

const DATABASE_PATH = DB_PATH;

function ensureDatabase() {
  fs.mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  setupDatabase();
  console.log('Datenbank und Tabellen erstellt/aktualisiert.');
}

async function main() {
  ensureDatabase();

  console.log('\nHole Spieldaten von API...');
  const matches = await fetchMatches({ mode: 'live' });
  console.log(`${matches.length} Spiele geladen.`);

  console.log('\nBerechne Features...');
  const features = calculateFeatures();
  console.log(`Features gespeichert (${features.length}).`);

  console.log('\nStarte KI-Vorhersage...');
  let matchId = null;
  if (matches.length > 0) {
    const first = matches[0];
    if (first && typeof first === 'object') {
      const fixture = first.fixture;
      if (fixture && typeof fixture === 'object' && fixture.id) {
        matchId = fixture.id;
      } else if (first.id) {
        matchId = first.id;
      } else if (first.match_id) {
        matchId = first.match_id;
      }
    }
  }

  if (matchId === null) {
    console.log('Konnte match_id nicht aus API-Daten ermitteln. Ueberspringe Prediction.');
    return;
  }

  const result = await predictMatch(matchId);
  console.log('\nErgebnis:');
  console.log(JSON.stringify(result, null, 2));
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error('Fehler im Hauptprogramm:', error);
    process.exitCode = 1;
  });
}
