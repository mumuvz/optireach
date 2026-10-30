-- AlterTable
ALTER TABLE `local_rank_scans` ADD COLUMN `captureNextUrl` TEXT NULL,
    ADD COLUMN `captureReason` TEXT NULL,
    ADD COLUMN `captureState` VARCHAR(20) NULL,
    ADD COLUMN `captureTarget` INTEGER NULL;

