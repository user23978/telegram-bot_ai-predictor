# GamblerGPT - AI-Powered Sports Prediction Bot

GamblerGPT ist eine Node.js-Anwendung mit Telegram-Bot, SQLite-Datenbank, API-Football/API-Sports-Daten, lokaler Feature-Engine und optionalem lokalen Ollama-LLM. Die v2-Pipeline ist darauf ausgelegt, zuverlässiger zu predicten, fehlende Daten klar zu erkennen und nicht mehr aus leeren Stats wilde Empfehlungen zu basteln. Ja, revolutionär: keine Fantasie-Zahlen füttern.

## Was v2 verbessert

- Robuster Predictor: `ai/predictorV2.js`
- Neuer Telegram-Bot: `bot/botV2.js`
- `npm run bot` startet jetzt automatisch v2
- API-Fetch-Diagnosen werden in `api_fetch_log` gespeichert
- Raw-API-Matches werden als `raw_json` gespeichert
- Liga, Land, Saison und Runde werden gespeichert
- FeatureEngine nutzt primär Team-IDs statt nur Teamnamen
- Debug zeigt lokale Samples, H2H, externe Daten und letzte API-Fetches
- Fehlende Daten werden nicht mehr als echte 0-Leistung interpretiert
- Bei schwacher Datenlage wird die Confidence automatisch konservativer begrenzt

## Voraussetzungen

- Node.js 18 oder höher empfohlen
- API-Football/API-Sports Key
- Telegram Bot Token
- Optional: Ollama für lokale LLM-Predictions

## Setup

```bash
npm install
```

Erstelle eine `.env`:

```ini
API_FOOTBALL_KEY=your_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
API_TIMEZONE=Europe/Berlin

# Ollama lokal
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=gemma3:27b
OLLAMA_NUM_CTX=8192
OLLAMA_NUM_PREDICT=900
OLLAMA_TIMEOUT_MS=90000

# Optional: eigener Remote-LLM-Endpunkt
# LLAMA_SERVER_URL=http://custom-llama-endpoint

# Optional
# API_TIMEOUT_MS=15000
# TEAM_HISTORY_SIZE=12
# H2H_HISTORY_SIZE=10
```

## Modell-Empfehlung für Ollama

Wenn Leistung egal ist und du einfach möglichst schlaue lokale Predictions willst, nimm zuerst:

```bash
ollama pull gemma3:27b
```

Dann in `.env`:

```ini
OLLAMA_MODEL=gemma3:27b
```

Alternative, falls du mehr reasoning willst:

```bash
ollama pull qwen3:32b
```

Dann:

```ini
OLLAMA_MODEL=qwen3:32b
```

Meine Reihenfolge für dieses Projekt:

1. `gemma3:27b` - sehr guter Allrounder, großer Kontext, gut für strukturierte Analyse.
2. `qwen3:32b` - starkes Reasoning, kann bei nüchternen JSON-Analysen sehr gut sein.
3. `deepseek-r1:32b` - starkes Reasoning, aber kann manchmal zu viel Denktext/Format-Müll produzieren, daher für JSON-Bot etwas nerviger.

## Bot starten

```bash
npm run bot
```

Alter Bot bleibt als Backup:

```bash
npm run bot:old
```

## CLI-Test

```bash
npm run predict:test
```

## Telegram-Befehle

```txt
/start
/matches
/search Bayern
/team Real Madrid
/predict 1335952
/debug_match 1335952
```

Der Bot nutzt Inline-Buttons für:

- Sportart auswählen
- Live-Spiele
- heutige Spiele
- kommende Spiele
- Team-Suche
- Match auswählen
- Prediction berechnen
- Debug-Daten anzeigen

## Debugging

Wenn Predictions komisch sind, zuerst:

```txt
/debug_match <match_id>
```

Wichtig sind diese Werte:

- `Feature Row`: gibt es berechnete Stats?
- `Usable Samples`: genug lokale Daten vorhanden?
- `Home History` / `Away History`: wurden letzte Spiele gefunden?
- `H2H`: direkte Duelle gefunden?
- `API Prediction`, `Odds`, `Standings`: externe API-Daten vorhanden?
- `Letzte API Fetches`: zeigt HTTP/API-Fehler und Response Counts

Wenn überall 0 steht, ist es jetzt sichtbar, ob die API nichts liefert, die Team-IDs fehlen oder wirklich keine historischen Spiele in der DB liegen.

## Sicherheit bei Predictions

Der Bot gibt keine garantierten Wetten aus. Wenn Daten schwach sind, wird die Confidence absichtlich reduziert und oft `Keine klare Wette` ausgegeben. Das ist kein Bug, das ist der Bot, der nicht komplett wahnsinnig ist.

## Projektstruktur

```txt
api/apiHandler.js       API-Fetching, Speicherung, Fetch-Logs
api/footballContext.js  Odds, Injuries, Standings, API-Prediction
features/featureEngine.js lokale Stats aus historischen Matches
ai/predictorV2.js       robuster Predictor + Ollama Prompting
bot/botV2.js            Telegram UI mit Buttons
data/dbSetup.js         SQLite Tabellen und Migrationen
```

## Haftungsausschluss

Nur Analyse und Lernprojekt. Keine finanzielle Beratung. Wette nicht mit Geld, das du brauchst. Der Kapitalismus ist schon peinlich genug.
