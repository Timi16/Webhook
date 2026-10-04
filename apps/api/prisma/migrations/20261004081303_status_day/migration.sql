-- CreateTable
CREATE TABLE "StatusDay" (
    "day" DATE NOT NULL,
    "component" TEXT NOT NULL,
    "ok" INTEGER NOT NULL DEFAULT 0,
    "degraded" INTEGER NOT NULL DEFAULT 0,
    "down" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "StatusDay_pkey" PRIMARY KEY ("day","component")
);
