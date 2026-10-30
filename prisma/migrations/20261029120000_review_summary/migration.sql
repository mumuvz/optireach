
-- CreateTable
CREATE TABLE `business_review_summaries` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `locationId` VARCHAR(32) NOT NULL,
    `reviewCount` INTEGER NOT NULL,
    `positive` INTEGER NOT NULL DEFAULT 0,
    `neutral` INTEGER NOT NULL DEFAULT 0,
    `negative` INTEGER NOT NULL DEFAULT 0,
    `themes` JSON NOT NULL,
    `summary` TEXT NOT NULL,
    `model` VARCHAR(80) NULL,
    `isDevAdapter` BOOLEAN NOT NULL DEFAULT false,
    `newestReviewAt` DATETIME(3) NULL,
    `generatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `generatedById` VARCHAR(32) NULL,

    UNIQUE INDEX `business_review_summaries_locationId_key`(`locationId`),
    INDEX `business_review_summaries_projectId_idx`(`projectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `business_review_summaries` ADD CONSTRAINT `business_review_summaries_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `business_review_summaries` ADD CONSTRAINT `business_review_summaries_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `business_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

