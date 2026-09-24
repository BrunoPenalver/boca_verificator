# ====================== STAGE 1: Dependencias (con herramientas de build) ======================
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# better-sqlite3 trae binarios precompilados, pero instalamos build tools
# por si el prebuild no está disponible para la plataforma
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

# ====================== STAGE 2: Compilar TypeScript ======================
FROM deps AS build
COPY tsconfig.json ./
COPY index.ts config.ts ./
RUN npx tsc

# ====================== STAGE 3: Runtime ======================
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    DATA_DIR=/app/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY public ./dist/public

# Directorio para la base SQLite (montar volumen para persistir la config)
RUN mkdir -p /app/data && chown -R node:node /app
USER node
VOLUME ["/app/data"]

EXPOSE 3001

CMD ["node", "dist/index.js"]
