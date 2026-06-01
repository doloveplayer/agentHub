-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "workspaceMode" TEXT NOT NULL DEFAULT 'sandbox',
ADD COLUMN     "workspacePath" TEXT,
ADD COLUMN     "writePermission" TEXT NOT NULL DEFAULT 'ask';
