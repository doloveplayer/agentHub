-- AlterTable
ALTER TABLE "Agent" ADD COLUMN     "containerId" TEXT,
ADD COLUMN     "containerStatus" TEXT NOT NULL DEFAULT 'stopped',
ADD COLUMN     "contextMode" TEXT NOT NULL DEFAULT 'shared',
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "hostWorkDir" TEXT,
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'user';

-- CreateTable
CREATE TABLE "AgentTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'claude-code',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentTemplate_name_key" ON "AgentTemplate"("name");
