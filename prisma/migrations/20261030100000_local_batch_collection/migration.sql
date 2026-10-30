-- AlterTable
ALTER TABLE `local_rank_scans` ADD COLUMN `collectionBatchSize` INTEGER NULL,
    ADD COLUMN `collectionCursor` TEXT NULL,
    ADD COLUMN `collectionDelayMs` INTEGER NULL,
    ADD COLUMN `collectionRunId` VARCHAR(32) NULL;

