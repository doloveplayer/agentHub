-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "cacheCreateTokens" INTEGER DEFAULT 0,
ADD COLUMN     "cacheReadTokens" INTEGER DEFAULT 0,
ADD COLUMN     "inputTokens" INTEGER DEFAULT 0,
ADD COLUMN     "outputTokens" INTEGER DEFAULT 0;

-- AlterTable
ALTER TABLE "SessionAgent" ADD COLUMN     "messageCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalCacheCreateTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalCacheReadTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "totalOutputTokens" INTEGER NOT NULL DEFAULT 0;
