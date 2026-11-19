# Railway image: the API, which also serves the staff dashboard (/) and the customer app (/shop/).
# Not included: the worker and the WhatsApp test bridge (WhatsApp is not hosted yet).
FROM node:22-bookworm-slim
WORKDIR /app
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

COPY . .
# Only what the API and the two web apps need (skips the WhatsApp bridge and its native modules).
RUN pnpm install --frozen-lockfile --filter "fmcg-assistant" --filter "@fmcg/api..." --filter "@fmcg/web" --filter "@fmcg/shop"
RUN pnpm --filter @fmcg/web build && pnpm --filter @fmcg/shop build

ENV NODE_ENV=production SERVE_STATIC=true TRUST_PROXY=true
# Database migrations run on every start (each runs once; already-applied ones are skipped).
CMD ["sh", "-c", "node_modules/.bin/tsx packages/db/src/migrate.ts && exec node_modules/.bin/tsx apps/api/src/main.ts"]
