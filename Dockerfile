FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production

# Instala só dependências de produção (usa o lockfile)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Código da aplicação
COPY . .

USER node
EXPOSE 3000

# Roda as migrations (idempotente) e sobe o servidor
CMD ["sh", "-c", "node db/migrate.js && node src/server.js"]
