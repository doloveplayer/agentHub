-- CreateTable
CREATE TABLE "PinnedMessage" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL DEFAULT 'message',
    "sourceMessageId" TEXT,
    "filePath" TEXT,
    "content" TEXT NOT NULL,
    "title" TEXT,
    "injectToAgent" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PinnedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PinnedMessage_sessionId_idx" ON "PinnedMessage"("sessionId");

-- AddForeignKey
ALTER TABLE "PinnedMessage" ADD CONSTRAINT "PinnedMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
