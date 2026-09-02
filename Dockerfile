FROM node:20-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY bot.js ./
COPY id.env.example ./

ENV NODE_ENV=production

CMD ["node", "bot.js"]
