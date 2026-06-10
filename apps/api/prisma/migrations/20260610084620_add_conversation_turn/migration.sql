-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "turnId" TEXT,
ADD COLUMN     "turnStatus" TEXT NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "ConversationTurn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "parentTurnId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "triggerMsgId" TEXT NOT NULL,
    "planExecutionId" TEXT,
    "workspaceSnapshot" JSONB,
    "contextEntryKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "planIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConversationTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationTurn_sessionId_idx" ON "ConversationTurn"("sessionId");

-- CreateIndex
CREATE INDEX "ConversationTurn_parentTurnId_idx" ON "ConversationTurn"("parentTurnId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationTurn_sessionId_sequence_key" ON "ConversationTurn"("sessionId", "sequence");

-- CreateIndex
CREATE INDEX "Message_turnId_idx" ON "Message"("turnId");

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_turnId_fkey" FOREIGN KEY ("turnId") REFERENCES "ConversationTurn"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationTurn" ADD CONSTRAINT "ConversationTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
