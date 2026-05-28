-- AlterTable: replace GitHub OAuth with username/password auth
ALTER TABLE "User" DROP CONSTRAINT IF EXISTS "User_githubId_key";
ALTER TABLE "User" DROP COLUMN "githubId";
ALTER TABLE "User" RENAME COLUMN "login" TO "username";
ALTER TABLE "User" ADD COLUMN "password" TEXT NOT NULL DEFAULT '';
ALTER TABLE "User" ADD CONSTRAINT "User_username_key" UNIQUE ("username");
