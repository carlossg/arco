FROM oven/bun:1.4.0 AS bun
FROM node:24-bookworm-slim
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV NODE_ENV=production
WORKDIR /app

COPY workers/recommender/package.json workers/recommender/bun.lock workers/recommender/
RUN bun install --cwd workers/recommender --production --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
COPY services/recommender/package.json services/recommender/bun.lock services/recommender/
RUN bun install --cwd services/recommender --production --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org

COPY workers/recommender/src workers/recommender/src
COPY workers/recommender/prompts workers/recommender/prompts
COPY workers/recommender/tools/precompile-prompts.js workers/recommender/tools/precompile-prompts.js
COPY workers/recommender/tools/json-loader.js workers/recommender/tools/json-loader.js
COPY services/recommender/src services/recommender/src
COPY data data
COPY schema schema
COPY eval/suites eval/suites
RUN node workers/recommender/tools/precompile-prompts.js

USER node
ENV PORT=8080
EXPOSE 8080
CMD ["node", "--loader", "./workers/recommender/tools/json-loader.js", "services/recommender/src/server.js"]
