/*
  Warnings:

  - You are about to drop the column `settings` on the `Agent` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Agent" DROP COLUMN "settings",
ADD COLUMN     "capabilities" JSONB,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'claude-code',
ADD COLUMN     "providerConfig" JSONB;

-- AlterTable
ALTER TABLE "SessionAgent" ADD COLUMN     "systemPromptOverride" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "encryptedApiKeys" TEXT,
ALTER COLUMN "avatarUrl" SET DEFAULT '',
ALTER COLUMN "password" DROP DEFAULT;
