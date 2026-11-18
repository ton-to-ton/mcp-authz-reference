FROM node:24-slim AS base
# package-lock.json was written by npm 11.6.2; the npm bundled with newer node:24 images (11.19)
# rejects it in `npm ci` (optional @emnapi peers missing). Pin npm until the lockfile is regenerated.
RUN npm install -g npm@11.6.2

FROM base AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM base
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node","dist/main.js"]
