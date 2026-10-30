-- CreateTable
CREATE TABLE `local_business_research` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `scanId` VARCHAR(32) NOT NULL,
    `resultIndex` INTEGER NOT NULL,
    `businessKey` VARCHAR(512) NOT NULL,
    `businessName` VARCHAR(255) NOT NULL,
    `query` VARCHAR(200) NOT NULL,
    `position` INTEGER NULL,
    `pageLocal` BOOLEAN NOT NULL DEFAULT false,
    `evidence` JSON NOT NULL,
    `report` JSON NOT NULL,
    `provider` VARCHAR(20) NOT NULL,
    `model` VARCHAR(80) NULL,
    `isDevAdapter` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `local_business_research_scanId_createdAt_idx`(`scanId`, `createdAt`),
    INDEX `local_business_research_projectId_businessKey_idx`(`projectId`, `businessKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `local_business_research` ADD CONSTRAINT `local_business_research_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `local_business_research` ADD CONSTRAINT `local_business_research_scanId_fkey` FOREIGN KEY (`scanId`) REFERENCES `local_rank_scans`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

