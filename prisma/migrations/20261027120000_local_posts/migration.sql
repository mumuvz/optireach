-- CreateTable
CREATE TABLE `local_posts` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `locationId` VARCHAR(32) NOT NULL,
    `topicType` VARCHAR(20) NOT NULL DEFAULT 'STANDARD',
    `summary` TEXT NOT NULL,
    `title` VARCHAR(255) NULL,
    `ctaType` VARCHAR(30) NULL,
    `ctaUrl` VARCHAR(2048) NULL,
    `origin` VARCHAR(10) NOT NULL,
    `model` VARCHAR(80) NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `scheduledAt` DATETIME(3) NULL,
    `googleName` VARCHAR(255) NULL,
    `searchUrl` VARCHAR(2048) NULL,
    `publishedAt` DATETIME(3) NULL,
    `publishedById` VARCHAR(32) NULL,
    `publishError` VARCHAR(2000) NULL,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `local_posts_projectId_status_idx`(`projectId`, `status`),
    INDEX `local_posts_locationId_idx`(`locationId`),
    INDEX `local_posts_status_scheduledAt_idx`(`status`, `scheduledAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `local_posts` ADD CONSTRAINT `local_posts_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `local_posts` ADD CONSTRAINT `local_posts_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `business_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

