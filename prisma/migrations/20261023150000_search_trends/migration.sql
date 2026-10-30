-- Search trends: a new job type, a recommendation source and the table of dated trend reports.

-- AlterTable
ALTER TABLE `background_job_records` MODIFY `type` ENUM('CRAWL', 'AUDIT', 'CONTENT_GENERATION', 'KEYWORD_SUGGESTIONS', 'VISIBILITY_RUN', 'COMPETITOR_SNAPSHOT', 'REPORT', 'INTEGRATION_SYNC', 'EMAIL', 'MAINTENANCE', 'PUBLISH', 'VERIFICATION', 'DISCOVERY', 'RANK_CHECK', 'WEB_VITALS', 'WEBHOOK_DELIVERY', 'AI_DRAFT', 'IMPORT', 'GAP_ANALYSIS', 'SEO_COMPARISON', 'TREND_REPORT') NOT NULL;

-- AlterTable
ALTER TABLE `recommendations` MODIFY `source` ENUM('AUDIT', 'AI_VISIBILITY', 'COMPETITOR', 'SEARCH_CONSOLE', 'LOCAL', 'COMMERCE', 'WEB_VITALS', 'RANK_TRACKING', 'SEARCH_TRENDS') NOT NULL;

-- CreateTable
CREATE TABLE `trend_reports` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `source` VARCHAR(20) NOT NULL,
    `createdById` VARCHAR(32) NULL,
    `keywords` JSON NOT NULL,
    `country` CHAR(2) NULL,
    `timeRange` VARCHAR(20) NOT NULL,
    `category` INTEGER NOT NULL DEFAULT 0,
    `data` JSON NULL,
    `analysis` JSON NULL,
    `errorMessage` TEXT NULL,
    `fetchedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `trend_reports_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `trend_reports` ADD CONSTRAINT `trend_reports_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
