# syntax=docker/dockerfile:1
# Risk Engine (SPEC-TRADING-RISK-001): somente paper trading. Imagem local; nada é publicado em registry.
#
# Base fixada por digest (índice multi-arquitetura de node:22-bookworm-slim, resolvido em 2026-11-14).
# Para atualizar: `docker pull node:22-bookworm-slim && docker buildx imagetools inspect node:22-bookworm-slim`,
# copie o "Digest:" do índice para o ARG abaixo, reconstrua (npm run image:build) e rode npm run test:e2e.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM ${NODE_IMAGE} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force \
    && find node_modules -name '*.js.map' -delete \
    && find node_modules -mindepth 1 -type d -empty -delete

FROM ${NODE_IMAGE} AS runtime
ARG VERSION
LABEL org.opencontainers.image.title="openclaw-risk-engine" \
      org.opencontainers.image.description="Motor determinístico de autorização de risco, exclusivamente paper trading (SPEC-TRADING-RISK-001)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.base.name="docker.io/library/node:22-bookworm-slim"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY package.json package-lock.json ./
# Gerenciadores de pacote não são necessários em runtime (HEALTHCHECK, ENTRYPOINT e CLI usam só `node`) e carregam
# dependências embutidas (CVEs de npm/corepack/yarn): removidos. node_modules da aplicação já foi copiado acima.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /opt/yarn-v* \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /usr/local/bin/yarn /usr/local/bin/yarnpkg
# Usuário numérico não-root (uid/gid 1000 = "node" da imagem base). O processo não escreve em disco:
# funciona com --read-only sem tmpfs. Segredos entram por arquivos montados (RISK_*_FILE), legíveis por uid 1000.
USER 1000:1000
ENTRYPOINT ["node", "dist/interfaces/http/main.js"]
# CLI: docker run --entrypoint node <imagem> dist/interfaces/cli/main.js <migrate|expire-reservations|verify-runtime-privileges|healthcheck>
# Sem intervalo/timeout/retries aqui: valem os defaults do Docker; o stack define os valores (deploy/stack.example.yml).
# O healthcheck sonda o próprio processo (loopback do contêiner quando o bind é private-network, ADR-0011); não sai pela rede.
HEALTHCHECK CMD ["node", "dist/interfaces/cli/main.js", "healthcheck"]
