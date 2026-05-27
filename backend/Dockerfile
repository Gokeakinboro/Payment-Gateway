FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

FROM base AS deps
COPY package*.json ./
RUN npm ci --only=production

FROM base AS runner
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate

EXPOSE 3000
CMD ["node", "src/server.js"]
