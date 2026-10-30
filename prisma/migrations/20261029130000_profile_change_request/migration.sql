-- CreateTable
CREATE TABLE `profile_change_requests` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `locationId` VARCHAR(32) NOT NULL,
    `fields` JSON NOT NULL,
    `status` VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    `publishedAt` DATETIME(3) NULL,
    `publishedById` VARCHAR(32) NULL,
    `publishError` VARCHAR(2000) NULL,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `profile_change_requests_projectId_status_idx`(`projectId`, `status`),
    INDEX `profile_change_requests_locationId_idx`(`locationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `profile_change_requests` ADD CONSTRAINT `profile_change_requests_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `profile_change_requests` ADD CONSTRAINT `profile_change_requests_locationId_fkey` FOREIGN KEY (`locationId`) REFERENCES `business_locations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

