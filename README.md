## Setup

1. Install dependencies:
   ```
   npm install
   ```
2. Create a `.env` file with:
   ```
API_FOOTBALL_KEY=your_api_key
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
# Optional: override if your Ollama API is not at the default host
# OLLAMA_HOST=http://localhost:11434
# OLLAMA_MODEL=llama3
# Optional: adjust API timezone (default Europe/Berlin)
# API_TIMEZONE=Europe/Berlin
# LLAMA_SERVER_URL=http://custom-llama-endpoint
```

## Running the CLI pipeline

```
npm start
```

## Telegram bot

```
npm run bot
```

## Ollama integration

1. Install [Ollama](https://ollama.ai) and download a model, for example:
   ```
   ollama pull llama3
   ```
2. Ensure the Ollama service is running (launches on demand when you call `ollama serve` or any `ollama` command).
3. Set the desired model name via `OLLAMA_MODEL` in `.env`. If omitted, the Node app assumes no Ollama integration.
4. Start the app or bot. When a prediction is requested, the code sends the prompt to the local Ollama API (`http://localhost:11434/api/generate`). If the model returns a valid JSON object with the expected fields, the bot labels the result as coming from `Ollama-Server (lokal)`. Otherwise it falls back to the rule-based predictor.
