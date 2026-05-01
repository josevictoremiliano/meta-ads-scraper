FROM mcr.microsoft.com/playwright:v1.44.0-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev
RUN npx playwright install chromium --with-deps

COPY src/ ./src/

ENV PORT=3000
ENV SCRAPER_API_KEY=trocar-aqui
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "src/server.js"]
