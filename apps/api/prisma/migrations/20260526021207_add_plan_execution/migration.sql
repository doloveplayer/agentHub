-- CreateTable
CREATE TABLE "PlanExecution" (
    "id" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "planTitle" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'pending_confirmation',
    "tasks" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlanExecution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlanExecution_sessionId_idx" ON "PlanExecution"("sessionId");

-- CreateIndex
CREATE INDEX "PlanExecution_planId_idx" ON "PlanExecution"("planId");

-- CreateIndex
CREATE UNIQUE INDEX "PlanExecution_sessionId_planId_key" ON "PlanExecution"("sessionId", "planId");
