-- CreateTable
CREATE TABLE "ScrapeStatus" (
    "courseId" INTEGER NOT NULL,
    "date" TEXT NOT NULL,
    "attemptedAt" TIMESTAMP(3) NOT NULL,
    "succeededAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "ScrapeStatus_pkey" PRIMARY KEY ("courseId","date")
);

-- AddForeignKey
ALTER TABLE "ScrapeStatus" ADD CONSTRAINT "ScrapeStatus_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;
