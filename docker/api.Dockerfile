FROM node:20-slim

WORKDIR /app

# Copy workspace config
COPY package.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/shared/package.json ./packages/shared/

# Install dependencies
RUN npm install --workspaces

# Copy source
COPY apps/api ./apps/api
COPY packages/shared ./packages/shared

# Generate Prisma client
WORKDIR /app/apps/api
RUN npx prisma generate

EXPOSE 3000
CMD ["npx", "tsx", "src/index.ts"]
