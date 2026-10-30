-- Competitor gap analysis: a new background job type and the table that stores each analysis.

-- AlterTable
ALTER TABLE `background_job_records` MODIFY `type` ENUM('CRAWL', 'AUDIT', 'CONTENT_GENERATION', 'KEYWORD_SUGGESTIONS', 'VISIBILITY_RUN', 'COMPETITOR_SNAPSHOT', 'REPORT', 'INTEGRATION_SYNC', 'EMAIL', 'MAINTENANCE', 'PUBLISH', 'VERIFICATION', 'DISCOVERY', 'RANK_CHECK', 'WEB_VITALS', 'WEBHOOK_DELIVERY', 'AI_DRAFT', 'IMPORT', 'GAP_ANALYSIS') NOT NULL;

-- CreateTable
CREATE TABLE `visibility_gap_analyses` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `createdById` VARCHAR(32) NULL,
    `result` JSON NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `visibility_gap_analyses_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `visibility_gap_analyses` ADD CONSTRAINT `visibility_gap_analyses_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
