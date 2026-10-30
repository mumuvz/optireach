-- CreateTable
CREATE TABLE `merchant_products` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `source` VARCHAR(20) NOT NULL,
    `offerId` VARCHAR(50) NOT NULL,
    `contentLanguage` VARCHAR(10) NOT NULL,
    `feedLabel` VARCHAR(20) NOT NULL,
    `title` VARCHAR(500) NULL,
    `data` JSON NOT NULL,
    `googleName` VARCHAR(500) NULL,
    `googleStatus` JSON NULL,
    `issues` JSON NOT NULL,
    `status` VARCHAR(10) NOT NULL,
    `errorCount` INTEGER NOT NULL DEFAULT 0,
    `warningCount` INTEGER NOT NULL DEFAULT 0,
    `importId` VARCHAR(32) NULL,
    `lastSeenAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `merchant_products_projectId_status_idx`(`projectId`, `status`),
    INDEX `merchant_products_projectId_source_lastSeenAt_idx`(`projectId`, `source`, `lastSeenAt`),
    UNIQUE INDEX `merchant_products_projectId_source_feedLabel_contentLanguage_key`(`projectId`, `source`, `feedLabel`, `contentLanguage`, `offerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `product_feed_imports` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `fileName` VARCHAR(200) NOT NULL,
    `format` VARCHAR(20) NOT NULL,
    `country` CHAR(2) NOT NULL,
    `language` VARCHAR(10) NOT NULL,
    `mode` VARCHAR(10) NOT NULL,
    `rows` INTEGER NOT NULL,
    `imported` INTEGER NOT NULL,
    `updated` INTEGER NOT NULL,
    `removed` INTEGER NOT NULL,
    `skipped` INTEGER NOT NULL,
    `rowErrors` JSON NOT NULL,
    `limitations` JSON NOT NULL,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `product_feed_imports_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `merchant_products` ADD CONSTRAINT `merchant_products_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `product_feed_imports` ADD CONSTRAINT `product_feed_imports_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

