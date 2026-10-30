-- AlterTable
ALTER TABLE `recommendations` ADD COLUMN `blockedAt` DATETIME(3) NULL,
    ADD COLUMN `blockedReason` VARCHAR(500) NULL,
    ADD COLUMN `dueAt` DATETIME(3) NULL,
    ADD COLUMN `effort` VARCHAR(20) NULL,
    ADD COLUMN `ownerRole` VARCHAR(20) NULL,
    ADD COLUMN `plannedAt` DATETIME(3) NULL,
    ADD COLUMN `verification` TEXT NULL,
    ADD COLUMN `verifiedAt` DATETIME(3) NULL,
    ADD COLUMN `verifiedById` VARCHAR(32) NULL,
    MODIFY `status` ENUM('OPEN', 'PLANNED', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'COMPLETED', 'VERIFIED', 'DISMISSED', 'BLOCKED') NOT NULL DEFAULT 'OPEN';

-- AddForeignKey
ALTER TABLE `recommendations` ADD CONSTRAINT `recommendations_verifiedById_fkey` FOREIGN KEY (`verifiedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

