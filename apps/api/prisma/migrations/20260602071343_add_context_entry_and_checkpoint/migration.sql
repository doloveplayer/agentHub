-- CreateTable
CREATE TABLE "ContextEntryRecord" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "author" TEXT NOT NULL,
    "taskId" TEXT,
    "planId" TEXT,
    "tags" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContextEntryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionCheckpoint" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionCheckpoint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContextEntryRecord_sessionId_idx" ON "ContextEntryRecord"("sessionId");

-- CreateIndex
CREATE INDEX "ContextEntryRecord_planId_idx" ON "ContextEntryRecord"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "ContextEntryRecord_sessionId_key_key" ON "ContextEntryRecord"("sessionId", "key");

-- CreateIndex
CREATE INDEX "SessionCheckpoint_sessionId_idx" ON "SessionCheckpoint"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "SessionCheckpoint_sessionId_planId_key" ON "SessionCheckpoint"("sessionId", "planId");
