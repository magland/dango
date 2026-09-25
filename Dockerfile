# The dango server image.
#
# Dango compiles mochiforge's sources in with its own, so the build context is
# the directory holding both checkouts side by side, not this one:
#
#   docker build -f dango/Dockerfile -t dango .     (from the parent directory)
#   docker build -f Dockerfile -t dango ..          (from inside dango)
#
# Dockerfile.dockerignore, beside this file, lets only the sources and the
# manifests through, whatever else the parent directory holds. `dango deploy
# fly --from-source` assembles the same two trees in a temporary directory and
# builds this file from there.
FROM node:24-alpine AS build
WORKDIR /build/dango
COPY dango/package.json dango/package-lock.json ./
RUN npm ci
# The shared modules sit in /build/mochiforge/src and find their packages by
# walking up from there, which reaches /build/node_modules and nothing else.
RUN ln -s /build/dango/node_modules /build/node_modules
COPY mochiforge/src /build/mochiforge/src
COPY dango/tsconfig.json ./
COPY dango/src ./src
RUN npm run build && npm prune --omit=dev

# The compiled output holds both halves (dist/dango and dist/mochiforge), so
# the runtime image needs neither checkout: only dist, the pruned packages,
# and package.json, which the server reads its version from.
FROM node:24-alpine
WORKDIR /app
COPY --from=build /build/dango/node_modules ./node_modules
COPY --from=build /build/dango/dist ./dist
COPY dango/package.json ./
RUN mkdir /workspace && chown node:node /workspace
USER node
VOLUME /workspace
EXPOSE 3000
CMD ["node", "dist/dango/src/index.js", "serve", "/workspace", "--host", "0.0.0.0", "--port", "3000"]
