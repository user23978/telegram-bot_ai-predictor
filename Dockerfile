# syntax=docker/dockerfile:1

FROM node:18-bullseye

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

EXPOSE 8080

# Hinweis: Stellen Sie sicher, dass API_FOOTBALL_KEY und TELEGRAM_BOT_TOKEN
# als Umgebungsvariablen gesetzt sind, bevor der Container gestartet wird.

CMD ["npm", "start"]
