
# GamblerGPT - AI‑Powered Sports Betting Assistant

GamblerGPT ist eine Node.js‑Anwendung, die Fußball‑ und Basketballspiele analysiert und Vorhersagen über einen CLI‑Pipeline oder einen Telegram‑Bot liefert. Das Programm ruft Live‑ und bevorstehende Spiele ab, berechnet Features aus Spieldaten und nutzt entweder einen regelbasierten Algorithmus oder ein lokales LLM, um Vorhersagen zu generieren. Der Telegram‑Bot bietet eine interaktive Oberfläche zum Auswählen von Sportarten, Durchstöbern von Spielen und Abrufen von Vorhersagen.

## Features

- Abruf von Live‑ und zukünftigen Fußball‑ und Basketballspielen über den API‑Football‑Service.
- Berechnung von Features und Generierung von Vorhersagen mithilfe eingebauter Algorithmen oder eines lokalen LLM (über Ollama).
- SQLite‑Datenbank zum Speichern von Spieldaten und Features.
- CLI‑Pipeline, die Daten abruft, Features berechnet und eine Vorhersage für ein Spiel ausgibt.
- Telegram‑Bot auf Basis von Telegraf, der Kommandos zum Durchstöbern von Spielen und Anfordern von Vorhersagen bietet.
- Optionale Integration mit Ollama, um lokale LLM‑Modelle (z. B. `llama3`) für Vorhersagen zu nutzen.

## Voraussetzungen

- Node.js (Version 16 oder höher)
- API‑Schlüssel:
  - **API_FOOTBALL_KEY** – Dein API‑Football‑Schlüssel zum Abrufen von Spieldaten.
  - **TELEGRAM_BOT_TOKEN** – Dein Telegram‑Bot‑Token.
- (Optional) [Ollama](https://ollama.ai) installiert mit einem heruntergeladenen Modell (z. B. `llama3`), wenn du lokale LLM‑Vorhersagen nutzen möchtest.

## Setup

1. Abhängigkeiten installieren:

   ```bash
   npm install
   ```

2. Erstelle eine Datei `.env` im Projektverzeichnis mit folgenden Variablen:

   ```ini
   API_FOOTBALL_KEY=your_api_key
   TELEGRAM_BOT_TOKEN=your_telegram_bot_token

   # Optional: überschreibe Host/Port für deinen lokalen Ollama‑API
   # OLLAMA_HOST=http://localhost:11434
   # OLLAMA_MODEL=llama3

   # Optional: Zeitzone für API‑Abfragen anpassen (Standard: Europe/Berlin)
   # API_TIMEZONE=Europe/Berlin

   # Optional: eigene LLM‑Server‑URL (falls du einen anderen Endpunkt nutzt)
   # LLAMA_SERVER_URL=http://custom-llama-endpoint
   ```

   Nur `API_FOOTBALL_KEY` und `TELEGRAM_BOT_TOKEN` sind erforderlich. Die übrigen Variablen konfigurieren optionale Features wie das lokale LLM oder eine benutzerdefinierte Zeitzone.

### Back4App Deployment

Back4App führt regelmäßige HTTP-Health-Checks durch. Damit der Check erfolgreich ist, stellt `server.js` einen schlanken HTTP-Server bereit und startet parallel den Telegram-Bot. Verwende für Deployments auf Back4App den Befehl `npm start`, damit der Health-Check auf Port `8080` beantwortet wird, während der Bot im Hintergrund weiterläuft. Stelle sicher, dass die notwendigen Umgebungsvariablen (`API_FOOTBALL_KEY`, `TELEGRAM_BOT_TOKEN` sowie optional weitere) im Back4App-Dashboard hinterlegt sind.

## Verwendung

### CLI‑Pipeline

Die CLI‑Pipeline richtet die Datenbank ein, ruft Live‑Spieldaten ab, berechnet Features und gibt eine Vorhersage für das erste verfügbare Spiel aus. Starte sie mit:

```bash
npm start
```

### Telegram‑Bot

Starte den Telegram‑Bot mit:

```bash
npm run bot
```

Sobald der Bot läuft, kannst du ihm in Telegram `/start` oder `/matches` senden, um eine Sportart zu wählen und Spiele zu durchsuchen. Du kannst auch direkt eine Vorhersage anfordern:

```
/predict <match_id>
```

Beispiel:

```
/predict 1335952
```

Der Bot antwortet mit dem prognostizierten Ausgang, Wahrscheinlichkeiten und einer Wett‑Empfehlung. Zusätzlich gibt es Schaltflächen für die Navigation zurück zu Live‑ oder kommenden Spielen.

### Ollama‑Integration (Optional)

Um Vorhersagen eines lokalen LLM zu aktivieren:

1. Installiere [Ollama](https://ollama.ai) und lade ein Modell herunter, beispielsweise:

   ```bash
   ollama pull llama3
   ```

2. Stelle sicher, dass der Ollama‑Dienst läuft (z. B. `ollama serve`). Standardmäßig lauscht er auf `http://localhost:11434`.

3. Setze `OLLAMA_MODEL=llama3` (oder deinen Modellnamen) in `.env`. Du kannst auch `OLLAMA_HOST` oder `LLAMA_SERVER_URL` anpassen, wenn dein Server woanders läuft.

4. Starte die CLI oder den Bot wie gewohnt. Wenn eine Vorhersage angefordert wird, ruft das Programm das lokale LLM auf. Liefert das Modell ein gültiges JSON mit den erwarteten Feldern, kennzeichnet der Bot das Ergebnis als `Ollama-Server (lokal)`. Andernfalls greift er auf den regelbasierten Prädiktor zurück.

## Datenbank

Dieses Projekt nutzt SQLite über `better-sqlite3`, um Spieldaten und berechnete Features in `data/gamblergpt.db` zu speichern. Die Datenbank und die benötigten Tabellen werden automatisch erstellt, wenn du die CLI oder den Bot startest.

## Mitwirken

Beiträge sind willkommen! Eröffne gerne Issues oder sende Pull Requests für Verbesserungen, Bugfixes oder neue Features.

## Haftungsausschluss

Dieses Projekt dient ausschließlich zu Lern‑ und Informationszwecken. Die vom Programm erzeugten Vorhersagen stellen keine finanzielle Beratung dar. Nutze die Informationen verantwortungsbewusst und auf eigenes Risiko.
