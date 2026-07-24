# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY src/persistence/pg/schema.sql ./src/persistence/pg/schema.sql
EXPOSE 3000
# AUDITA_JWT_SECRET must be provided at runtime (the app refuses the dev default in production).
CMD ["node", "dist/api/main.js"]
