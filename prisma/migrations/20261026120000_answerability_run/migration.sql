-- CreateTable
CREATE TABLE `answerability_runs` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `provider` VARCHAR(20) NULL,
    `model` VARCHAR(120) NULL,
    `isDevAdapter` BOOLEAN NOT NULL DEFAULT false,
    `score` INTEGER NULL,
    `grade` VARCHAR(20) NULL,
    `assessment` JSON NULL,
    `pagesConsidered` INTEGER NOT NULL DEFAULT 0,
    `questionsConsidered` INTEGER NOT NULL DEFAULT 0,
    `limitations` JSON NULL,
    `errorMessage` TEXT NULL,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `finishedAt` DATETIME(3) NULL,

    INDEX `answerability_runs_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `answerability_runs` ADD CONSTRAINT `answerability_runs_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

