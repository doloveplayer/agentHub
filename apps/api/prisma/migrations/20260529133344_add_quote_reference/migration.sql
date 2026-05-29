-- CreateTable
CREATE TABLE "QuoteReference" (
    "id" TEXT NOT NULL,
    "sourceMessageId" TEXT NOT NULL,
    "targetMessageId" TEXT,
    "agentId" TEXT,
    "selectionText" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'message',
    "contextMeta" JSONB,
    "sessionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuoteReference_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "QuoteReference" ADD CONSTRAINT "QuoteReference_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
