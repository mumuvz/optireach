-- AlterTable
ALTER TABLE `background_job_records` MODIFY `type` ENUM('CRAWL', 'AUDIT', 'CONTENT_GENERATION', 'KEYWORD_SUGGESTIONS', 'VISIBILITY_RUN', 'COMPETITOR_SNAPSHOT', 'REPORT', 'INTEGRATION_SYNC', 'EMAIL', 'MAINTENANCE', 'PUBLISH', 'VERIFICATION', 'DISCOVERY', 'RANK_CHECK', 'WEB_VITALS', 'WEBHOOK_DELIVERY', 'AI_DRAFT', 'IMPORT') NOT NULL;

-- AlterTable
ALTER TABLE `integrations` MODIFY `provider` ENUM('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS_4', 'WORDPRESS', 'SHOPIFY', 'GOOGLE_BUSINESS_PROFILE', 'GOOGLE_MERCHANT_CENTER', 'CMS_WEBHOOK') NOT NULL;

-- AlterTable
ALTER TABLE `oauth_states` MODIFY `provider` ENUM('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS_4', 'WORDPRESS', 'SHOPIFY', 'GOOGLE_BUSINESS_PROFILE', 'GOOGLE_MERCHANT_CENTER', 'CMS_WEBHOOK') NOT NULL;

-- AlterTable
ALTER TABLE `recommendations` MODIFY `category` ENUM('TECHNICAL_SEO', 'CONTENT', 'AEO', 'GEO', 'STRUCTURED_DATA', 'PERFORMANCE', 'INTERNAL_LINKING', 'LOCAL_SEO', 'ECOMMERCE', 'SEARCH_PERFORMANCE', 'INTERNATIONAL', 'AUTHORITY', 'PAGE_EXPERIENCE') NOT NULL,
    MODIFY `source` ENUM('AUDIT', 'AI_VISIBILITY', 'COMPETITOR', 'SEARCH_CONSOLE', 'LOCAL', 'COMMERCE', 'WEB_VITALS', 'RANK_TRACKING') NOT NULL;

-- AlterTable
ALTER TABLE `usage_records` MODIFY `metric` ENUM('AUDIT_RUN', 'CRAWL_PAGES', 'VISIBILITY_CHECK', 'CONTENT_GENERATION', 'KEYWORD_SUGGESTION', 'COMPETITOR_SNAPSHOT', 'REPORT', 'RANK_CHECK', 'LOCAL_RANK_POINT', 'WEB_VITALS_CHECK', 'API_REQUEST') NOT NULL;

-- AlterTable
ALTER TABLE `workspace_invitations` MODIFY `role` ENUM('OWNER', 'ADMIN', 'MEMBER', 'CLIENT') NOT NULL DEFAULT 'MEMBER';

-- AlterTable
ALTER TABLE `workspace_members` MODIFY `role` ENUM('OWNER', 'ADMIN', 'MEMBER', 'CLIENT') NOT NULL DEFAULT 'MEMBER';

-- AlterTable
ALTER TABLE `workspaces` ADD COLUMN `isServiceProvider` BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE `agency_client_links` (
    `id` VARCHAR(32) NOT NULL,
    `agencyWorkspaceId` VARCHAR(32) NOT NULL,
    `clientWorkspaceId` VARCHAR(32) NOT NULL,
    `status` ENUM('PENDING', 'ACTIVE', 'REVOKED') NOT NULL DEFAULT 'PENDING',
    `accessRole` ENUM('OWNER', 'ADMIN', 'MEMBER', 'CLIENT') NOT NULL DEFAULT 'ADMIN',
    `approvalsDelegated` BOOLEAN NOT NULL DEFAULT false,
    `billingMode` ENUM('AGENCY', 'CLIENT') NOT NULL DEFAULT 'CLIENT',
    `invitedById` VARCHAR(32) NULL,
    `acceptedById` VARCHAR(32) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `revokedById` VARCHAR(32) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `agency_client_links_clientWorkspaceId_status_idx`(`clientWorkspaceId`, `status`),
    UNIQUE INDEX `agency_client_links_agencyWorkspaceId_clientWorkspaceId_key`(`agencyWorkspaceId`, `clientWorkspaceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_requests` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NULL,
    `entityType` VARCHAR(40) NOT NULL,
    `entityId` VARCHAR(32) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `summary` TEXT NULL,
    `snapshot` JSON NOT NULL,
    `snapshotHash` CHAR(64) NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED', 'WITHDRAWN', 'SUPERSEDED') NOT NULL DEFAULT 'PENDING',
    `requestedById` VARCHAR(32) NULL,
    `requestedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedById` VARCHAR(32) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` VARCHAR(2000) NULL,
    `decidedVia` VARCHAR(30) NULL,
    `dueAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `approval_requests_workspaceId_status_requestedAt_idx`(`workspaceId`, `status`, `requestedAt`),
    INDEX `approval_requests_entityType_entityId_requestedAt_idx`(`entityType`, `entityId`, `requestedAt`),
    INDEX `approval_requests_projectId_status_idx`(`projectId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `tasks` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NULL,
    `type` VARCHAR(30) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NULL,
    `status` ENUM('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'DONE', 'CANCELLED') NOT NULL DEFAULT 'TODO',
    `priority` ENUM('HIGH', 'MEDIUM', 'LOW') NOT NULL DEFAULT 'MEDIUM',
    `assigneeId` VARCHAR(32) NULL,
    `dueDate` DATE NULL,
    `periodKey` CHAR(7) NULL,
    `clientVisible` BOOLEAN NOT NULL DEFAULT false,
    `entityType` VARCHAR(40) NULL,
    `entityId` VARCHAR(32) NULL,
    `createdById` VARCHAR(32) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `tasks_workspaceId_status_dueDate_idx`(`workspaceId`, `status`, `dueDate`),
    INDEX `tasks_projectId_status_idx`(`projectId`, `status`),
    INDEX `tasks_assigneeId_status_idx`(`assigneeId`, `status`),
    INDEX `tasks_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `task_time_entries` (
    `id` VARCHAR(32) NOT NULL,
    `taskId` VARCHAR(32) NOT NULL,
    `userId` VARCHAR(32) NULL,
    `minutes` INTEGER NOT NULL,
    `workDate` DATE NOT NULL,
    `note` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `task_time_entries_taskId_idx`(`taskId`),
    INDEX `task_time_entries_userId_workDate_idx`(`userId`, `workDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `provider_rates` (
    `id` VARCHAR(32) NOT NULL,
    `provider` VARCHAR(40) NOT NULL,
    `operation` VARCHAR(40) NULL,
    `unit` VARCHAR(20) NOT NULL,
    `priceMicros` BIGINT NOT NULL,
    `unitQuantity` INTEGER NOT NULL DEFAULT 1,
    `currency` CHAR(3) NOT NULL DEFAULT 'USD',
    `effectiveFrom` DATETIME(3) NOT NULL,
    `note` VARCHAR(500) NULL,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `provider_rates_provider_operation_effectiveFrom_idx`(`provider`, `operation`, `effectiveFrom`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `provider_usage_events` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NULL,
    `projectId` VARCHAR(32) NULL,
    `provider` VARCHAR(40) NOT NULL,
    `operation` VARCHAR(40) NOT NULL,
    `model` VARCHAR(80) NULL,
    `inputTokens` INTEGER NULL,
    `outputTokens` INTEGER NULL,
    `requests` INTEGER NOT NULL DEFAULT 1,
    `costMicros` BIGINT NULL,
    `currency` CHAR(3) NULL,
    `backgroundJobId` VARCHAR(32) NULL,
    `idempotencyKey` VARCHAR(160) NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `provider_usage_events_idempotencyKey_key`(`idempotencyKey`),
    INDEX `provider_usage_events_workspaceId_occurredAt_idx`(`workspaceId`, `occurredAt`),
    INDEX `provider_usage_events_provider_occurredAt_idx`(`provider`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `domain_events` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NULL,
    `type` VARCHAR(60) NOT NULL,
    `entityType` VARCHAR(40) NULL,
    `entityId` VARCHAR(32) NULL,
    `actorUserId` VARCHAR(32) NULL,
    `data` JSON NULL,
    `occurredAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `domain_events_workspaceId_occurredAt_idx`(`workspaceId`, `occurredAt`),
    INDEX `domain_events_type_occurredAt_idx`(`type`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `agency_client_links` ADD CONSTRAINT `agency_client_links_agencyWorkspaceId_fkey` FOREIGN KEY (`agencyWorkspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `agency_client_links` ADD CONSTRAINT `agency_client_links_clientWorkspaceId_fkey` FOREIGN KEY (`clientWorkspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_requestedById_fkey` FOREIGN KEY (`requestedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `approval_requests` ADD CONSTRAINT `approval_requests_decidedById_fkey` FOREIGN KEY (`decidedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `tasks` ADD CONSTRAINT `tasks_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_time_entries` ADD CONSTRAINT `task_time_entries_taskId_fkey` FOREIGN KEY (`taskId`) REFERENCES `tasks`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `task_time_entries` ADD CONSTRAINT `task_time_entries_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `provider_usage_events` ADD CONSTRAINT `provider_usage_events_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `domain_events` ADD CONSTRAINT `domain_events_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

