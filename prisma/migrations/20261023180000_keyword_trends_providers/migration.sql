-- AlterTable
ALTER TABLE `trend_reports` ADD COLUMN `cacheKey` CHAR(64) NULL,
    ADD COLUMN `cachedFromId` VARCHAR(32) NULL,
    ADD COLUMN `expiresAt` DATETIME(3) NULL,
    ADD COLUMN `include` JSON NULL,
    ADD COLUMN `language` VARCHAR(12) NOT NULL DEFAULT 'en',
    ADD COLUMN `limitations` JSON NULL,
    ADD COLUMN `partial` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `region` VARCHAR(10) NULL,
    ADD COLUMN `savedQueryId` VARCHAR(32) NULL,
    ADD COLUMN `suggestPlacements` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `trigger` ENUM('MANUAL', 'SCHEDULED', 'PUBLIC', 'SYSTEM') NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE `trend_observations` (
    `id` VARCHAR(32) NOT NULL,
    `reportId` VARCHAR(32) NOT NULL,
    `keyword` VARCHAR(100) NOT NULL,
    `periodStart` DATETIME(3) NOT NULL,
    `value` DOUBLE NULL,
    `isPartial` BOOLEAN NOT NULL DEFAULT false,

    INDEX `trend_observations_reportId_keyword_periodStart_idx`(`reportId`, `keyword`, `periodStart`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trend_regional_interest` (
    `id` VARCHAR(32) NOT NULL,
    `reportId` VARCHAR(32) NOT NULL,
    `keyword` VARCHAR(100) NOT NULL,
    `geoCode` VARCHAR(20) NULL,
    `regionName` VARCHAR(150) NOT NULL,
    `resolution` VARCHAR(10) NOT NULL,
    `comparison` VARCHAR(10) NOT NULL DEFAULT 'single',
    `value` DOUBLE NULL,

    INDEX `trend_regional_interest_reportId_keyword_idx`(`reportId`, `keyword`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trend_related_items` (
    `id` VARCHAR(32) NOT NULL,
    `reportId` VARCHAR(32) NOT NULL,
    `keyword` VARCHAR(100) NULL,
    `kind` VARCHAR(10) NOT NULL,
    `list` VARCHAR(10) NOT NULL,
    `rank` INTEGER NOT NULL,
    `label` VARCHAR(255) NOT NULL,
    `topicType` VARCHAR(80) NULL,
    `value` DOUBLE NULL,
    `growth` VARCHAR(20) NULL,

    INDEX `trend_related_items_reportId_kind_list_rank_idx`(`reportId`, `kind`, `list`, `rank`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trend_csv_imports` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `reportId` VARCHAR(32) NULL,
    `createdById` VARCHAR(32) NULL,
    `fileName` VARCHAR(200) NOT NULL,
    `kind` VARCHAR(30) NOT NULL,
    `keywords` JSON NOT NULL,
    `country` CHAR(2) NULL,
    `region` VARCHAR(10) NULL,
    `timeRange` VARCHAR(20) NULL,
    `headerNote` VARCHAR(120) NULL,
    `rowCount` INTEGER NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `trend_csv_imports_projectId_createdAt_idx`(`projectId`, `createdAt`),
    INDEX `trend_csv_imports_reportId_idx`(`reportId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trend_provider_events` (
    `id` VARCHAR(32) NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `operation` VARCHAR(40) NOT NULL,
    `outcome` VARCHAR(20) NOT NULL,
    `message` VARCHAR(500) NULL,
    `durationMs` INTEGER NULL,
    `workspaceId` VARCHAR(32) NULL,
    `projectId` VARCHAR(32) NULL,
    `reportId` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `trend_provider_events_provider_createdAt_idx`(`provider`, `createdAt`),
    INDEX `trend_provider_events_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `trend_saved_queries` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `keywords` JSON NOT NULL,
    `country` CHAR(2) NULL,
    `region` VARCHAR(10) NULL,
    `timeRange` VARCHAR(20) NOT NULL,
    `category` INTEGER NOT NULL DEFAULT 0,
    `provider` VARCHAR(20) NULL,
    `schedule` VARCHAR(10) NOT NULL DEFAULT 'NONE',
    `nextRunAt` DATETIME(3) NULL,
    `lastReportId` VARCHAR(32) NULL,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `trend_saved_queries_schedule_nextRunAt_idx`(`schedule`, `nextRunAt`),
    UNIQUE INDEX `trend_saved_queries_projectId_name_key`(`projectId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `trend_reports_cacheKey_status_expiresAt_idx` ON `trend_reports`(`cacheKey`, `status`, `expiresAt`);

-- CreateIndex
CREATE INDEX `trend_reports_savedQueryId_idx` ON `trend_reports`(`savedQueryId`);

-- AddForeignKey
ALTER TABLE `trend_reports` ADD CONSTRAINT `trend_reports_savedQueryId_fkey` FOREIGN KEY (`savedQueryId`) REFERENCES `trend_saved_queries`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trend_observations` ADD CONSTRAINT `trend_observations_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `trend_reports`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trend_regional_interest` ADD CONSTRAINT `trend_regional_interest_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `trend_reports`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trend_related_items` ADD CONSTRAINT `trend_related_items_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `trend_reports`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trend_csv_imports` ADD CONSTRAINT `trend_csv_imports_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trend_csv_imports` ADD CONSTRAINT `trend_csv_imports_reportId_fkey` FOREIGN KEY (`reportId`) REFERENCES `trend_reports`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `trend_saved_queries` ADD CONSTRAINT `trend_saved_queries_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

