FROM node:22-alpine

# python/make/g++ needed to rebuild better-sqlite3 for Linux/musl
RUN apk add --no-cache python3 make g++

WORKDIR /app

EXPOSE 4477

# Install on every start so a fresh named volume self-populates;
# subsequent starts skip the real work because lockfile + node_modules are present.
CMD ["sh", "-c", "npm install --prefer-offline --no-audit && npm run dev"]
