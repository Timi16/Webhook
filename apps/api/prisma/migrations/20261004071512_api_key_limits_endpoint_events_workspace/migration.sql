-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN     "allowedIps" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "lastUsedIp" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY['payments:read', 'watches:write', 'endpoints:write']::TEXT[];

-- AlterTable
ALTER TABLE "Developer" ADD COLUMN     "workspace" TEXT;

-- AlterTable
ALTER TABLE "Endpoint" ADD COLUMN     "eventTypes" TEXT[] DEFAULT ARRAY['payment.received', 'payment.rejected']::TEXT[];

-- CreateTable
CREATE TABLE "ApiKeyRequest" (
    "id" TEXT NOT NULL,
    "apiKeyId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "status" INTEGER NOT NULL,
    "durationMs" INTEGER NOT NULL,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKeyRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKeyRequest_apiKeyId_createdAt_idx" ON "ApiKeyRequest"("apiKeyId", "createdAt");

-- AddForeignKey
ALTER TABLE "ApiKeyRequest" ADD CONSTRAINT "ApiKeyRequest_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "ApiKey"("id") ON DELETE CASCADE ON UPDATE CASCADE;
