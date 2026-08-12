FROM oven/bun:1.3.14-debian AS builder

WORKDIR /app

COPY package.json bun.lock nuxt.config.ts tsconfig.json ./
# pg is pure JavaScript, so no native build scripts are needed.
RUN BUN_FEATURE_FLAG_DISABLE_NATIVE_DEPENDENCY_LINKER=1 \
    bun install --frozen-lockfile --ignore-scripts

COPY app ./app
COPY public ./public
COPY server ./server
COPY monitor-server.mjs ./monitor-server.mjs

RUN bun run build

# pg is loaded at runtime via createRequire, so it must exist as a real
# node_modules entry. Resolving it in an isolated directory keeps the runtime
# image free of build-only dependencies.
FROM oven/bun:1.3.14-debian AS runtime-deps

WORKDIR /runtime-deps
COPY package.json bun.lock ./
RUN BUN_FEATURE_FLAG_DISABLE_NATIVE_DEPENDENCY_LINKER=1 \
    bun install --production --frozen-lockfile --ignore-scripts \
    && rm -rf /root/.bun/install/cache

FROM oven/bun:1.3.14-debian AS runner

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

WORKDIR /app

COPY --from=runtime-deps --chown=bun:bun /runtime-deps/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/.output ./.output
COPY --from=builder --chown=bun:bun /app/monitor-server.mjs ./monitor-server.mjs
COPY --from=builder --chown=bun:bun /app/public ./public

USER bun
EXPOSE 3000 3031

CMD ["bun", ".output/server/index.mjs"]
