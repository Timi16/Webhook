-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "developerId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetId" TEXT,
    "targetLabel" TEXT,
    "actor" TEXT NOT NULL,
    "apiKeyId" TEXT,
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AuditLog_developerId_createdAt_idx" ON "AuditLog"("developerId", "createdAt");

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_developerId_fkey" FOREIGN KEY ("developerId") REFERENCES "Developer"("id") ON DELETE CASCADE ON UPDATE CASCADE;
