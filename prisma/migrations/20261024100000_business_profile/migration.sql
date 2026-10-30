-- AlterTable
ALTER TABLE `business_locations` ADD COLUMN `profileAccountName` VARCHAR(120) NULL,
    ADD COLUMN `profileLinkedAt` DATETIME(3) NULL;

-- CreateTable
CREATE TABLE `business_profile_snapshots` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `locationId` VARCHAR(32) NOT NULL,
    `profileLocationName` VARCHAR(120) NOT NULL,
    `data` JSON NOT NULL,
    `averageRating` DECIMAL(3, 2) NULL,
    `totalReviewCount` INTEGER NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `business_profile_snapshots_locationId_fetchedAt_idx`(`locationId`, `fetchedAt`),
    INDEX `business_profile_snapshots_projectId_idx`(`projectId`),
    INDEX `business_profile_snapshots_fetchedAt_idx`(`fetchedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `business_profile_metrics` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `locationId` VARCHAR(32) NOT NULL,
    `metric` VARCHAR(60) NOT NULL,
    `date` DATE NOT NULL,
    `value` INTEGER NOT NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `business_profile_metrics_projectId_idx`(`projectId`),
    INDEX `business_profile_metrics_fetchedAt_idx`(`fetchedAt`),
    UNIQUE INDEX `business_profile_metrics_locationId_metric_date_key`(`locationId`, `metric`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `business_reviews` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `locationId` VARCHAR(32) NOT NULL,
    `reviewName` VARCHAR(255) NOT NULL,
    `reviewerName` VARCHAR(255) NULL,
    `isAnonymous` BOOLEAN NOT NULL DEFAULT false,
    `starRating` TINYINT NULL,
    `comment` TEXT NULL,
    `createTime` DATETIME(3) NOT NULL,
    `updateTime` DATETIME(3) NULL,
    `replyComment` TEXT NULL,
    `replyUpdateTime` DATETIME(3) NULL,
    `fetchedAt` DATETIME(3) NOT NULL,

    INDEX `business_reviews_locationId_createTime_idx`(`locationId`, `createTime`),
    INDEX `business_reviews_projectId_idx`(`projectId`),
    INDEX `business_reviews_fetchedAt_idx`(`fetchedAt`),
    UNIQUE INDEX `business_reviews_reviewName_key`(`reviewName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `review_replies` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `locationId` VARCHAR(32) NOT NULL,
    `reviewName` VARCHAR(255) NOT NULL,
    `comment` TEXT NOT NULL,
    `origin` VARCHAR(10) NOT NULL,
    `model` VARCHAR(80) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `publishedAt` DATETIME(3) NULL,
    `publishedById` VARCHAR(32) NULL,
    `publishError` VARCHAR(2000) NULL,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `review_replies_projectId_status_idx`(`projectId`, `status`),
    INDEX `review_replies_reviewName_idx`(`reviewName`),
    INDEX `review_replies_locationId_idx`(`locationId`),
    INDEX `review_replies_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `business_profile_snapshots` ADD CONSTRAINT `business_profile_snapshots_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_profile_snapshots` ADD CONSTRAINT `business_profile_snapshots_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `business_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_profile_metrics` ADD CONSTRAINT `business_profile_metrics_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_profile_metrics` ADD CONSTRAINT `business_profile_metrics_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `business_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_reviews` ADD CONSTRAINT `business_reviews_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_reviews` ADD CONSTRAINT `business_reviews_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `business_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `review_replies` ADD CONSTRAINT `review_replies_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `review_replies` ADD CONSTRAINT `review_replies_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `business_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `review_replies` ADD CONSTRAINT `review_replies_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

