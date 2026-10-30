-- AlterTable
ALTER TABLE `project_competitors` ADD COLUMN `address` VARCHAR(300) NULL,
    ADD COLUMN `category` VARCHAR(120) NULL,
    ADD COLUMN `cid` VARCHAR(40) NULL,
    ADD COLUMN `firstSeenAt` DATETIME(3) NULL,
    ADD COLUMN `kind` VARCHAR(10) NOT NULL DEFAULT 'WEBSITE',
    ADD COLUMN `lastSeenAt` DATETIME(3) NULL,
    ADD COLUMN `latitude` DECIMAL(10, 7) NULL,
    ADD COLUMN `locationId` VARCHAR(32) NULL,
    ADD COLUMN `longitude` DECIMAL(10, 7) NULL,
    ADD COLUMN `placeId` VARCHAR(200) NULL,
    ADD COLUMN `rating` DOUBLE NULL,
    ADD COLUMN `reviewCount` INTEGER NULL,
    ADD COLUMN `source` VARCHAR(12) NOT NULL DEFAULT 'MANUAL',
    ADD COLUMN `status` VARCHAR(12) NOT NULL DEFAULT 'CONFIRMED',
    MODIFY `domain` VARCHAR(253) NULL;

-- AlterTable
ALTER TABLE `projects` ADD COLUMN `businessProfile` JSON NULL,
    MODIFY `websiteUrl` VARCHAR(2048) NULL,
    MODIFY `domain` VARCHAR(253) NULL;

-- CreateTable
CREATE TABLE `business_locations` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `kind` VARCHAR(15) NOT NULL DEFAULT 'STOREFRONT',
    `primaryCategory` VARCHAR(120) NULL,
    `secondaryCategories` JSON NULL,
    `addressLine1` VARCHAR(200) NULL,
    `addressLine2` VARCHAR(200) NULL,
    `locality` VARCHAR(120) NULL,
    `city` VARCHAR(120) NOT NULL,
    `region` VARCHAR(120) NULL,
    `postalCode` VARCHAR(20) NULL,
    `country` CHAR(2) NOT NULL,
    `serviceAreas` JSON NULL,
    `latitude` DECIMAL(10, 7) NULL,
    `longitude` DECIMAL(10, 7) NULL,
    `phone` VARCHAR(40) NULL,
    `email` VARCHAR(254) NULL,
    `websiteUrl` VARCHAR(2048) NULL,
    `openingHours` JSON NULL,
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `source` VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
    `profileLocationName` VARCHAR(120) NULL,
    `placeId` VARCHAR(200) NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `business_locations_projectId_archivedAt_idx`(`projectId`, `archivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `local_rank_queries` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `locationId` VARCHAR(32) NOT NULL,
    `query` VARCHAR(200) NOT NULL,
    `surface` VARCHAR(12) NOT NULL DEFAULT 'MAPS',
    `language` VARCHAR(12) NOT NULL,
    `device` VARCHAR(10) NOT NULL DEFAULT 'mobile',
    `gridSize` INTEGER NOT NULL DEFAULT 5,
    `spacingKm` DOUBLE NOT NULL DEFAULT 1,
    `depth` INTEGER NOT NULL DEFAULT 20,
    `centerLatitude` DECIMAL(10, 7) NOT NULL,
    `centerLongitude` DECIMAL(10, 7) NOT NULL,
    `frequency` VARCHAR(10) NOT NULL DEFAULT 'MANUAL',
    `nextRunAt` DATETIME(3) NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'ACTIVE',
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `local_rank_queries_frequency_nextRunAt_idx`(`frequency`, `nextRunAt`),
    UNIQUE INDEX `local_rank_queries_projectId_locationId_query_surface_device_key`(`projectId`, `locationId`, `query`, `surface`, `device`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `local_rank_scans` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `queryId` VARCHAR(32) NOT NULL,
    `source` VARCHAR(20) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `trigger` ENUM('MANUAL', 'SCHEDULED', 'PUBLIC', 'SYSTEM') NOT NULL DEFAULT 'MANUAL',
    `query` VARCHAR(200) NOT NULL,
    `surface` VARCHAR(12) NOT NULL,
    `language` VARCHAR(12) NOT NULL,
    `device` VARCHAR(10) NOT NULL,
    `gridSize` INTEGER NOT NULL,
    `spacingKm` DOUBLE NOT NULL,
    `depth` INTEGER NOT NULL,
    `centerLatitude` DECIMAL(10, 7) NOT NULL,
    `centerLongitude` DECIMAL(10, 7) NOT NULL,
    `pointsPlanned` INTEGER NOT NULL,
    `pointsMeasured` INTEGER NOT NULL DEFAULT 0,
    `pointsFailed` INTEGER NOT NULL DEFAULT 0,
    `top3` INTEGER NOT NULL DEFAULT 0,
    `top10` INTEGER NOT NULL DEFAULT 0,
    `notFound` INTEGER NOT NULL DEFAULT 0,
    `top3Share` DOUBLE NULL,
    `averageRankFound` DOUBLE NULL,
    `costUsd` DOUBLE NULL,
    `limitations` JSON NULL,
    `errorMessage` TEXT NULL,
    `createdById` VARCHAR(32) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `local_rank_scans_queryId_createdAt_idx`(`queryId`, `createdAt`),
    INDEX `local_rank_scans_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `local_rank_points` (
    `id` VARCHAR(32) NOT NULL,
    `scanId` VARCHAR(32) NOT NULL,
    `row` INTEGER NOT NULL,
    `col` INTEGER NOT NULL,
    `latitude` DECIMAL(10, 7) NOT NULL,
    `longitude` DECIMAL(10, 7) NOT NULL,
    `status` VARCHAR(10) NOT NULL DEFAULT 'PENDING',
    `rank` INTEGER NULL,
    `results` JSON NULL,
    `error` VARCHAR(500) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `checkedAt` DATETIME(3) NULL,

    UNIQUE INDEX `local_rank_points_scanId_row_col_key`(`scanId`, `row`, `col`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `project_competitors_projectId_status_idx` ON `project_competitors`(`projectId`, `status`);

-- CreateIndex
CREATE INDEX `project_competitors_locationId_idx` ON `project_competitors`(`locationId`);

-- CreateIndex
CREATE UNIQUE INDEX `project_competitors_projectId_placeId_key` ON `project_competitors`(`projectId`, `placeId`);

-- AddForeignKey
ALTER TABLE `project_competitors` ADD CONSTRAINT `project_competitors_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `business_locations`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_locations` ADD CONSTRAINT `business_locations_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `local_rank_queries` ADD CONSTRAINT `local_rank_queries_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `local_rank_queries` ADD CONSTRAINT `local_rank_queries_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `business_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `local_rank_scans` ADD CONSTRAINT `local_rank_scans_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `local_rank_scans` ADD CONSTRAINT `local_rank_scans_queryId_fkey` FOREIGN KEY (`queryId`) REFERENCES `local_rank_queries`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `local_rank_points` ADD CONSTRAINT `local_rank_points_scanId_fkey` FOREIGN KEY (`scanId`) REFERENCES `local_rank_scans`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

