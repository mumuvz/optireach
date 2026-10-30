-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(32) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `emailVerifiedAt` DATETIME(3) NULL,
    `platformRole` ENUM('USER', 'ADMIN') NOT NULL DEFAULT 'USER',
    `disabledAt` DATETIME(3) NULL,
    `disabledReason` VARCHAR(500) NULL,
    `deletionRequestedAt` DATETIME(3) NULL,
    `lastWorkspaceId` VARCHAR(32) NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `notificationPrefs` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    INDEX `users_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` VARCHAR(32) NOT NULL,
    `userId` VARCHAR(32) NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `ipAddress` VARCHAR(64) NULL,
    `userAgent` VARCHAR(400) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `sessions_tokenHash_key`(`tokenHash`),
    INDEX `sessions_userId_idx`(`userId`),
    INDEX `sessions_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_tokens` (
    `id` VARCHAR(32) NOT NULL,
    `userId` VARCHAR(32) NOT NULL,
    `type` ENUM('EMAIL_VERIFICATION', 'PASSWORD_RESET') NOT NULL,
    `tokenHash` CHAR(64) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `user_tokens_tokenHash_key`(`tokenHash`),
    INDEX `user_tokens_userId_type_idx`(`userId`, `type`),
    INDEX `user_tokens_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspaces` (
    `id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `slug` VARCHAR(140) NOT NULL,
    `whiteLabel` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workspaces_slug_key`(`slug`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_members` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `userId` VARCHAR(32) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `workspace_members_userId_idx`(`userId`),
    UNIQUE INDEX `workspace_members_workspaceId_userId_key`(`workspaceId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workspace_invitations` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `role` ENUM('OWNER', 'ADMIN', 'MEMBER') NOT NULL DEFAULT 'MEMBER',
    `tokenHash` CHAR(64) NOT NULL,
    `invitedById` VARCHAR(32) NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `workspace_invitations_tokenHash_key`(`tokenHash`),
    INDEX `workspace_invitations_workspaceId_idx`(`workspaceId`),
    INDEX `workspace_invitations_email_idx`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `projects` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` TEXT NULL,
    `websiteUrl` VARCHAR(2048) NOT NULL,
    `domain` VARCHAR(253) NOT NULL,
    `industry` VARCHAR(80) NULL,
    `targetCountries` JSON NOT NULL,
    `targetLanguages` JSON NOT NULL,
    `brandVoice` TEXT NULL,
    `brandAliases` JSON NULL,
    `crawlSettings` JSON NOT NULL,
    `auditSchedule` ENUM('MANUAL', 'WEEKLY', 'MONTHLY') NOT NULL DEFAULT 'MANUAL',
    `nextAuditAt` DATETIME(3) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `projects_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    INDEX `projects_auditSchedule_nextAuditAt_idx`(`auditSchedule`, `nextAuditAt`),
    UNIQUE INDEX `projects_workspaceId_domain_key`(`workspaceId`, `domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_competitors` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `domain` VARCHAR(253) NOT NULL,
    `aliases` JSON NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `project_competitors_projectId_domain_key`(`projectId`, `domain`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `competitor_snapshots` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `competitorId` VARCHAR(32) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `pages` JSON NULL,
    `robotsAllowed` BOOLEAN NULL,
    `errorMessage` TEXT NULL,
    `fetchedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `competitor_snapshots_competitorId_createdAt_idx`(`competitorId`, `createdAt`),
    INDEX `competitor_snapshots_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `crawl_jobs` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `trigger` ENUM('MANUAL', 'SCHEDULED', 'PUBLIC', 'SYSTEM') NOT NULL DEFAULT 'MANUAL',
    `startUrl` VARCHAR(2048) NOT NULL,
    `settings` JSON NOT NULL,
    `pagesDiscovered` INTEGER NOT NULL DEFAULT 0,
    `pagesCrawled` INTEGER NOT NULL DEFAULT 0,
    `pagesFailed` INTEGER NOT NULL DEFAULT 0,
    `progress` INTEGER NOT NULL DEFAULT 0,
    `robotsInfo` JSON NULL,
    `sitemapInfo` JSON NULL,
    `cancelRequestedAt` DATETIME(3) NULL,
    `errorMessage` TEXT NULL,
    `createdById` VARCHAR(32) NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isDemo` BOOLEAN NOT NULL DEFAULT false,

    INDEX `crawl_jobs_projectId_createdAt_idx`(`projectId`, `createdAt`),
    INDEX `crawl_jobs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `crawled_pages` (
    `id` VARCHAR(32) NOT NULL,
    `crawlJobId` VARCHAR(32) NOT NULL,
    `url` VARCHAR(2048) NOT NULL,
    `urlHash` CHAR(64) NOT NULL,
    `finalUrl` VARCHAR(2048) NULL,
    `depth` INTEGER NOT NULL,
    `source` ENUM('SEED', 'SITEMAP', 'LINK', 'REDIRECT') NOT NULL,
    `statusCode` INTEGER NULL,
    `contentType` VARCHAR(160) NULL,
    `responseTimeMs` INTEGER NULL,
    `contentLength` INTEGER NULL,
    `redirectChain` JSON NULL,
    `isHtml` BOOLEAN NOT NULL DEFAULT false,
    `isIndexable` BOOLEAN NOT NULL DEFAULT false,
    `indexabilityReason` VARCHAR(255) NULL,
    `title` VARCHAR(1024) NULL,
    `metaDescription` TEXT NULL,
    `canonicalUrl` VARCHAR(2048) NULL,
    `metaRobots` VARCHAR(255) NULL,
    `xRobotsTag` VARCHAR(255) NULL,
    `lang` VARCHAR(35) NULL,
    `h1` VARCHAR(1024) NULL,
    `h1Count` INTEGER NOT NULL DEFAULT 0,
    `headings` JSON NULL,
    `wordCount` INTEGER NULL,
    `imagesTotal` INTEGER NULL,
    `imagesMissingAlt` INTEGER NULL,
    `internalLinksOut` INTEGER NULL,
    `externalLinksOut` INTEGER NULL,
    `inlinksCount` INTEGER NOT NULL DEFAULT 0,
    `structuredData` JSON NULL,
    `signals` JSON NULL,
    `contentHash` VARCHAR(32) NULL,
    `inSitemap` BOOLEAN NOT NULL DEFAULT false,
    `fetchError` VARCHAR(500) NULL,
    `fetchedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `crawled_pages_crawlJobId_statusCode_idx`(`crawlJobId`, `statusCode`),
    INDEX `crawled_pages_crawlJobId_isIndexable_idx`(`crawlJobId`, `isIndexable`),
    UNIQUE INDEX `crawled_pages_crawlJobId_urlHash_key`(`crawlJobId`, `urlHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `crawled_links` (
    `crawlJobId` VARCHAR(32) NOT NULL,
    `fromPageId` VARCHAR(32) NOT NULL,
    `toUrlHash` CHAR(64) NOT NULL,
    `toUrl` VARCHAR(2048) NOT NULL,
    `anchorText` VARCHAR(255) NULL,
    `nofollow` BOOLEAN NOT NULL DEFAULT false,

    INDEX `crawled_links_crawlJobId_toUrlHash_idx`(`crawlJobId`, `toUrlHash`),
    INDEX `crawled_links_fromPageId_idx`(`fromPageId`),
    PRIMARY KEY (`crawlJobId`, `fromPageId`, `toUrlHash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_runs` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NULL,
    `crawlJobId` VARCHAR(32) NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `score` INTEGER NULL,
    `categoryScores` JSON NULL,
    `issueCounts` JSON NULL,
    `pagesAnalyzed` INTEGER NULL,
    `scoringVersion` VARCHAR(20) NOT NULL,
    `weights` JSON NOT NULL,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isDemo` BOOLEAN NOT NULL DEFAULT false,

    INDEX `audit_runs_projectId_createdAt_idx`(`projectId`, `createdAt`),
    INDEX `audit_runs_crawlJobId_idx`(`crawlJobId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_issues` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `ruleId` VARCHAR(64) NOT NULL,
    `category` ENUM('CRAWLABILITY', 'METADATA', 'CONTENT_STRUCTURE', 'INTERNAL_LINKS', 'IMAGES', 'STRUCTURED_DATA', 'HTTP_ERRORS', 'PERFORMANCE') NOT NULL,
    `severity` ENUM('CRITICAL', 'HIGH', 'MEDIUM', 'LOW') NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `url` VARCHAR(2048) NULL,
    `urlHash` CHAR(64) NULL,
    `title` VARCHAR(255) NOT NULL,
    `description` TEXT NOT NULL,
    `evidence` JSON NULL,
    `suggestedFix` TEXT NOT NULL,
    `status` ENUM('OPEN', 'IGNORED', 'RESOLVED') NOT NULL DEFAULT 'OPEN',
    `firstDetectedAt` DATETIME(3) NOT NULL,
    `lastDetectedAt` DATETIME(3) NOT NULL,
    `firstAuditRunId` VARCHAR(32) NULL,
    `lastAuditRunId` VARCHAR(32) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `ignoredAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `audit_issues_projectId_status_severity_idx`(`projectId`, `status`, `severity`),
    INDEX `audit_issues_projectId_category_idx`(`projectId`, `category`),
    INDEX `audit_issues_projectId_ruleId_idx`(`projectId`, `ruleId`),
    INDEX `audit_issues_projectId_urlHash_idx`(`projectId`, `urlHash`),
    INDEX `audit_issues_lastAuditRunId_idx`(`lastAuditRunId`),
    UNIQUE INDEX `audit_issues_projectId_fingerprint_key`(`projectId`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_issue_occurrences` (
    `auditRunId` VARCHAR(32) NOT NULL,
    `issueId` VARCHAR(32) NOT NULL,
    `crawledPageId` VARCHAR(32) NULL,
    `severity` ENUM('CRITICAL', 'HIGH', 'MEDIUM', 'LOW') NOT NULL,

    INDEX `audit_issue_occurrences_issueId_idx`(`issueId`),
    INDEX `audit_issue_occurrences_crawledPageId_idx`(`crawledPageId`),
    PRIMARY KEY (`auditRunId`, `issueId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `public_audits` (
    `id` VARCHAR(32) NOT NULL,
    `url` VARCHAR(2048) NOT NULL,
    `domain` VARCHAR(253) NOT NULL,
    `ipHash` CHAR(64) NOT NULL,
    `accessTokenHash` CHAR(64) NOT NULL,
    `crawlJobId` VARCHAR(32) NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `result` JSON NULL,
    `errorMessage` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `public_audits_crawlJobId_key`(`crawlJobId`),
    INDEX `public_audits_ipHash_createdAt_idx`(`ipHash`, `createdAt`),
    INDEX `public_audits_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_prompts` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `text` VARCHAR(1000) NOT NULL,
    `intent` VARCHAR(60) NULL,
    `country` CHAR(2) NOT NULL,
    `language` VARCHAR(12) NOT NULL,
    `targetBrand` VARCHAR(120) NOT NULL,
    `providers` JSON NOT NULL,
    `frequency` ENUM('MANUAL', 'DAILY', 'WEEKLY', 'MONTHLY') NOT NULL DEFAULT 'WEEKLY',
    `status` ENUM('ACTIVE', 'PAUSED') NOT NULL DEFAULT 'ACTIVE',
    `lastRunAt` DATETIME(3) NULL,
    `nextRunAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ai_prompts_projectId_status_idx`(`projectId`, `status`),
    INDEX `ai_prompts_status_frequency_nextRunAt_idx`(`status`, `frequency`, `nextRunAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_prompt_competitors` (
    `promptId` VARCHAR(32) NOT NULL,
    `competitorId` VARCHAR(32) NOT NULL,

    INDEX `ai_prompt_competitors_competitorId_idx`(`competitorId`),
    PRIMARY KEY (`promptId`, `competitorId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_visibility_runs` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `trigger` ENUM('MANUAL', 'SCHEDULED', 'PUBLIC', 'SYSTEM') NOT NULL DEFAULT 'MANUAL',
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `promptCount` INTEGER NOT NULL DEFAULT 0,
    `observationCount` INTEGER NOT NULL DEFAULT 0,
    `successCount` INTEGER NOT NULL DEFAULT 0,
    `failureCount` INTEGER NOT NULL DEFAULT 0,
    `errorMessage` TEXT NULL,
    `startedAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isDemo` BOOLEAN NOT NULL DEFAULT false,

    INDEX `ai_visibility_runs_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_visibility_observations` (
    `id` VARCHAR(32) NOT NULL,
    `runId` VARCHAR(32) NOT NULL,
    `promptId` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `provider` VARCHAR(40) NOT NULL,
    `model` VARCHAR(80) NULL,
    `country` CHAR(2) NOT NULL,
    `language` VARCHAR(12) NOT NULL,
    `promptText` VARCHAR(1000) NOT NULL,
    `status` ENUM('SUCCEEDED', 'FAILED') NOT NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `attempts` INTEGER NOT NULL DEFAULT 1,
    `errorCode` VARCHAR(60) NULL,
    `errorMessage` VARCHAR(1000) NULL,
    `rawResponse` JSON NULL,
    `answerText` MEDIUMTEXT NULL,
    `brandMentioned` BOOLEAN NOT NULL DEFAULT false,
    `brandCited` BOOLEAN NOT NULL DEFAULT false,
    `brandRank` INTEGER NULL,
    `sentiment` ENUM('POSITIVE', 'NEUTRAL', 'NEGATIVE', 'MIXED') NULL,
    `sentimentSource` VARCHAR(20) NULL,
    `sentimentConfidence` DOUBLE NULL,
    `latencyMs` INTEGER NULL,
    `usage` JSON NULL,
    `idempotencyKey` VARCHAR(120) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ai_visibility_observations_idempotencyKey_key`(`idempotencyKey`),
    INDEX `ai_visibility_observations_projectId_observedAt_idx`(`projectId`, `observedAt`),
    INDEX `ai_visibility_observations_projectId_provider_observedAt_idx`(`projectId`, `provider`, `observedAt`),
    INDEX `ai_visibility_observations_promptId_observedAt_idx`(`promptId`, `observedAt`),
    INDEX `ai_visibility_observations_runId_idx`(`runId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `brand_mentions` (
    `id` VARCHAR(32) NOT NULL,
    `observationId` VARCHAR(32) NOT NULL,
    `entityType` ENUM('BRAND', 'COMPETITOR') NOT NULL,
    `competitorId` VARCHAR(32) NULL,
    `entityName` VARCHAR(120) NOT NULL,
    `matchedText` VARCHAR(255) NOT NULL,
    `matchType` ENUM('NAME', 'ALIAS', 'DOMAIN', 'AI_ENTITY') NOT NULL,
    `position` INTEGER NOT NULL,
    `rank` INTEGER NOT NULL,
    `snippet` VARCHAR(500) NULL,
    `confidence` DOUBLE NULL,

    INDEX `brand_mentions_observationId_idx`(`observationId`),
    INDEX `brand_mentions_competitorId_idx`(`competitorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ai_citations` (
    `id` VARCHAR(32) NOT NULL,
    `observationId` VARCHAR(32) NOT NULL,
    `url` VARCHAR(2048) NOT NULL,
    `domain` VARCHAR(253) NOT NULL,
    `title` VARCHAR(500) NULL,
    `position` INTEGER NOT NULL,
    `sourceType` ENUM('INLINE_CITATION', 'SEARCH_RESULT', 'MENTIONED_URL') NOT NULL,
    `isOwnedDomain` BOOLEAN NOT NULL DEFAULT false,
    `competitorId` VARCHAR(32) NULL,

    INDEX `ai_citations_observationId_idx`(`observationId`),
    INDEX `ai_citations_domain_idx`(`domain`),
    INDEX `ai_citations_competitorId_idx`(`competitorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_briefs` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `primaryKeyword` VARCHAR(200) NOT NULL,
    `secondaryKeywords` JSON NULL,
    `searchIntent` ENUM('INFORMATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'NAVIGATIONAL') NOT NULL DEFAULT 'INFORMATIONAL',
    `targetAudience` VARCHAR(500) NULL,
    `country` CHAR(2) NOT NULL,
    `language` VARCHAR(12) NOT NULL,
    `brandVoice` TEXT NULL,
    `targetUrl` VARCHAR(2048) NULL,
    `wordCountTarget` INTEGER NULL,
    `notes` TEXT NULL,
    `outline` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `content_briefs_projectId_createdAt_idx`(`projectId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_documents` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `briefId` VARCHAR(32) NULL,
    `title` VARCHAR(255) NOT NULL,
    `status` ENUM('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `wordCount` INTEGER NOT NULL DEFAULT 0,
    `latestVersion` INTEGER NOT NULL DEFAULT 0,
    `targetUrl` VARCHAR(2048) NULL,
    `assigneeId` VARCHAR(32) NULL,
    `approvedById` VARCHAR(32) NULL,
    `reviewRequestedAt` DATETIME(3) NULL,
    `approvedAt` DATETIME(3) NULL,
    `publishedAt` DATETIME(3) NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `content_documents_projectId_status_idx`(`projectId`, `status`),
    INDEX `content_documents_projectId_updatedAt_idx`(`projectId`, `updatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `content_versions` (
    `id` VARCHAR(32) NOT NULL,
    `documentId` VARCHAR(32) NOT NULL,
    `versionNumber` INTEGER NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body` MEDIUMTEXT NOT NULL,
    `outline` JSON NULL,
    `metaTitle` VARCHAR(255) NULL,
    `metaDescription` VARCHAR(500) NULL,
    `faqs` JSON NULL,
    `internalLinks` JSON NULL,
    `schemaJsonLd` JSON NULL,
    `wordCount` INTEGER NOT NULL DEFAULT 0,
    `source` ENUM('MANUAL', 'AI_GENERATION', 'AI_SECTION', 'RESTORE') NOT NULL DEFAULT 'MANUAL',
    `provider` VARCHAR(40) NULL,
    `model` VARCHAR(80) NULL,
    `isDevAdapter` BOOLEAN NOT NULL DEFAULT false,
    `generationJobId` VARCHAR(32) NULL,
    `note` VARCHAR(500) NULL,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `content_versions_generationJobId_key`(`generationJobId`),
    UNIQUE INDEX `content_versions_documentId_versionNumber_key`(`documentId`, `versionNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `keyword_lists` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `keyword_lists_projectId_name_key`(`projectId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `topic_clusters` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` VARCHAR(500) NULL,
    `pillarUrl` VARCHAR(2048) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `topic_clusters_projectId_name_key`(`projectId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `project_keywords` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `listId` VARCHAR(32) NULL,
    `clusterId` VARCHAR(32) NULL,
    `phrase` VARCHAR(200) NOT NULL,
    `normalizedPhrase` VARCHAR(200) NOT NULL,
    `intent` ENUM('INFORMATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'NAVIGATIONAL') NULL,
    `country` CHAR(2) NOT NULL,
    `language` VARCHAR(12) NOT NULL,
    `priority` ENUM('HIGH', 'MEDIUM', 'LOW') NOT NULL DEFAULT 'MEDIUM',
    `status` ENUM('IDEA', 'PLANNED', 'IN_PROGRESS', 'PUBLISHED', 'OPTIMIZING', 'DISCARDED') NOT NULL DEFAULT 'IDEA',
    `isPrimary` BOOLEAN NOT NULL DEFAULT false,
    `relatedQuestions` JSON NULL,
    `targetUrl` VARCHAR(2048) NULL,
    `notes` VARCHAR(1000) NULL,
    `source` ENUM('MANUAL', 'CSV_IMPORT', 'AI_SUGGESTION', 'PROVIDER') NOT NULL DEFAULT 'MANUAL',
    `searchVolume` INTEGER NULL,
    `difficulty` INTEGER NULL,
    `cpc` DECIMAL(10, 2) NULL,
    `metricsCurrency` CHAR(3) NULL,
    `metricsSource` VARCHAR(60) NULL,
    `metricsFetchedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `project_keywords_projectId_status_idx`(`projectId`, `status`),
    INDEX `project_keywords_projectId_priority_idx`(`projectId`, `priority`),
    INDEX `project_keywords_clusterId_idx`(`clusterId`),
    INDEX `project_keywords_listId_idx`(`listId`),
    UNIQUE INDEX `project_keywords_projectId_normalizedPhrase_country_language_key`(`projectId`, `normalizedPhrase`, `country`, `language`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `recommendations` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `fingerprint` CHAR(64) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `category` ENUM('TECHNICAL_SEO', 'CONTENT', 'AEO', 'GEO', 'STRUCTURED_DATA', 'PERFORMANCE', 'INTERNAL_LINKING') NOT NULL,
    `source` ENUM('AUDIT', 'AI_VISIBILITY', 'COMPETITOR') NOT NULL,
    `severity` ENUM('CRITICAL', 'HIGH', 'MEDIUM', 'LOW') NOT NULL,
    `relatedUrl` VARCHAR(2048) NULL,
    `expectedBenefit` TEXT NOT NULL,
    `benefitLevel` ENUM('HIGH', 'MEDIUM', 'LOW') NOT NULL,
    `evidence` JSON NOT NULL,
    `proposedFix` TEXT NOT NULL,
    `status` ENUM('OPEN', 'IN_PROGRESS', 'AWAITING_APPROVAL', 'COMPLETED', 'DISMISSED') NOT NULL DEFAULT 'OPEN',
    `assigneeId` VARCHAR(32) NULL,
    `dismissedReason` VARCHAR(500) NULL,
    `startedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `dismissedAt` DATETIME(3) NULL,
    `lastGeneratedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `recommendations_projectId_status_idx`(`projectId`, `status`),
    INDEX `recommendations_projectId_category_idx`(`projectId`, `category`),
    UNIQUE INDEX `recommendations_projectId_fingerprint_key`(`projectId`, `fingerprint`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `integrations` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `provider` ENUM('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS_4', 'WORDPRESS', 'SHOPIFY') NOT NULL,
    `status` ENUM('CONNECTED', 'DISCONNECTED', 'ERROR', 'NEEDS_REAUTH') NOT NULL DEFAULT 'DISCONNECTED',
    `externalAccount` VARCHAR(254) NULL,
    `config` JSON NULL,
    `scopes` VARCHAR(1000) NULL,
    `connectedById` VARCHAR(32) NULL,
    `connectedAt` DATETIME(3) NULL,
    `lastSyncAt` DATETIME(3) NULL,
    `lastSyncStatus` VARCHAR(40) NULL,
    `lastError` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `integrations_workspaceId_idx`(`workspaceId`),
    UNIQUE INDEX `integrations_projectId_provider_key`(`projectId`, `provider`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_tokens` (
    `id` VARCHAR(32) NOT NULL,
    `integrationId` VARCHAR(32) NOT NULL,
    `accessTokenEnc` TEXT NOT NULL,
    `refreshTokenEnc` TEXT NULL,
    `tokenType` VARCHAR(40) NULL,
    `scope` VARCHAR(1000) NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `oauth_tokens_integrationId_key`(`integrationId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `oauth_states` (
    `id` VARCHAR(32) NOT NULL,
    `stateHash` CHAR(64) NOT NULL,
    `provider` ENUM('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS_4', 'WORDPRESS', 'SHOPIFY') NOT NULL,
    `userId` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `codeVerifierEnc` TEXT NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `oauth_states_stateHash_key`(`stateHash`),
    INDEX `oauth_states_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `search_console_metrics` (
    `id` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `integrationId` VARCHAR(32) NOT NULL,
    `dimension` ENUM('DATE', 'QUERY', 'PAGE') NOT NULL,
    `rangeStart` DATE NOT NULL,
    `rangeEnd` DATE NOT NULL,
    `key` VARCHAR(2048) NOT NULL,
    `keyHash` CHAR(64) NOT NULL,
    `clicks` INTEGER NOT NULL,
    `impressions` INTEGER NOT NULL,
    `ctr` DOUBLE NOT NULL,
    `position` DOUBLE NOT NULL,
    `syncedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `search_console_metrics_projectId_dimension_rangeStart_idx`(`projectId`, `dimension`, `rangeStart`),
    UNIQUE INDEX `search_console_metrics_integrationId_dimension_rangeStart_ra_key`(`integrationId`, `dimension`, `rangeStart`, `rangeEnd`, `keyHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscription_plans` (
    `id` VARCHAR(32) NOT NULL,
    `key` VARCHAR(32) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `description` VARCHAR(500) NOT NULL,
    `currency` CHAR(3) NOT NULL DEFAULT 'USD',
    `priceMonthly` DECIMAL(10, 2) NOT NULL,
    `priceYearly` DECIMAL(10, 2) NOT NULL,
    `limits` JSON NOT NULL,
    `features` JSON NOT NULL,
    `highlighted` BOOLEAN NOT NULL DEFAULT false,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `stripePriceMonthlyId` VARCHAR(120) NULL,
    `stripePriceYearlyId` VARCHAR(120) NULL,
    `razorpayPlanMonthlyId` VARCHAR(120) NULL,
    `razorpayPlanYearlyId` VARCHAR(120) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `subscription_plans_key_key`(`key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `subscriptions` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `planId` VARCHAR(32) NOT NULL,
    `status` ENUM('ACTIVE', 'TRIALING', 'PAST_DUE', 'CANCELED', 'INCOMPLETE', 'UNPAID') NOT NULL DEFAULT 'ACTIVE',
    `provider` ENUM('NONE', 'DEV', 'STRIPE', 'RAZORPAY') NOT NULL DEFAULT 'NONE',
    `interval` ENUM('MONTH', 'YEAR') NOT NULL DEFAULT 'MONTH',
    `providerCustomerId` VARCHAR(120) NULL,
    `providerSubscriptionId` VARCHAR(120) NULL,
    `currentPeriodStart` DATETIME(3) NULL,
    `currentPeriodEnd` DATETIME(3) NULL,
    `cancelAtPeriodEnd` BOOLEAN NOT NULL DEFAULT false,
    `canceledAt` DATETIME(3) NULL,
    `lastPaymentFailedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `subscriptions_workspaceId_key`(`workspaceId`),
    INDEX `subscriptions_provider_providerSubscriptionId_idx`(`provider`, `providerSubscriptionId`),
    INDEX `subscriptions_provider_providerCustomerId_idx`(`provider`, `providerCustomerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `billing_invoices` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `subscriptionId` VARCHAR(32) NULL,
    `provider` ENUM('NONE', 'DEV', 'STRIPE', 'RAZORPAY') NOT NULL,
    `providerInvoiceId` VARCHAR(120) NOT NULL,
    `amount` DECIMAL(10, 2) NOT NULL,
    `currency` CHAR(3) NOT NULL,
    `status` ENUM('PAID', 'OPEN', 'FAILED', 'VOID', 'REFUNDED') NOT NULL,
    `description` VARCHAR(255) NULL,
    `periodStart` DATETIME(3) NULL,
    `periodEnd` DATETIME(3) NULL,
    `hostedUrl` VARCHAR(2048) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `billing_invoices_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    UNIQUE INDEX `billing_invoices_provider_providerInvoiceId_key`(`provider`, `providerInvoiceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `webhook_events` (
    `id` VARCHAR(32) NOT NULL,
    `provider` ENUM('NONE', 'DEV', 'STRIPE', 'RAZORPAY') NOT NULL,
    `eventId` VARCHAR(160) NOT NULL,
    `type` VARCHAR(120) NOT NULL,
    `status` ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED') NOT NULL DEFAULT 'RECEIVED',
    `summary` JSON NULL,
    `error` TEXT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `processedAt` DATETIME(3) NULL,

    INDEX `webhook_events_status_idx`(`status`),
    UNIQUE INDEX `webhook_events_provider_eventId_key`(`provider`, `eventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `usage_records` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NULL,
    `metric` ENUM('AUDIT_RUN', 'CRAWL_PAGES', 'VISIBILITY_CHECK', 'CONTENT_GENERATION', 'KEYWORD_SUGGESTION', 'COMPETITOR_SNAPSHOT', 'REPORT') NOT NULL,
    `quantity` INTEGER NOT NULL,
    `periodKey` CHAR(7) NOT NULL,
    `idempotencyKey` VARCHAR(160) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `usage_records_idempotencyKey_key`(`idempotencyKey`),
    INDEX `usage_records_workspaceId_metric_periodKey_idx`(`workspaceId`, `metric`, `periodKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reports` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NOT NULL,
    `projectId` VARCHAR(32) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `sections` JSON NOT NULL,
    `dateFrom` DATETIME(3) NOT NULL,
    `dateTo` DATETIME(3) NOT NULL,
    `status` ENUM('QUEUED', 'GENERATING', 'READY', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `htmlPath` VARCHAR(500) NULL,
    `pdfPath` VARCHAR(500) NULL,
    `pdfStatus` VARCHAR(20) NULL,
    `sizeBytes` INTEGER NULL,
    `limitations` JSON NULL,
    `summary` JSON NULL,
    `whiteLabel` JSON NULL,
    `errorMessage` TEXT NULL,
    `generatedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(32) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `reports_projectId_createdAt_idx`(`projectId`, `createdAt`),
    INDEX `reports_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` VARCHAR(32) NOT NULL,
    `userId` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NULL,
    `type` VARCHAR(60) NOT NULL,
    `title` VARCHAR(255) NOT NULL,
    `body` TEXT NULL,
    `link` VARCHAR(500) NULL,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `notifications_userId_readAt_createdAt_idx`(`userId`, `readAt`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `background_job_records` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NULL,
    `projectId` VARCHAR(32) NULL,
    `userId` VARCHAR(32) NULL,
    `type` ENUM('CRAWL', 'AUDIT', 'CONTENT_GENERATION', 'KEYWORD_SUGGESTIONS', 'VISIBILITY_RUN', 'COMPETITOR_SNAPSHOT', 'REPORT', 'INTEGRATION_SYNC', 'EMAIL', 'MAINTENANCE') NOT NULL,
    `status` ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `queueName` VARCHAR(60) NOT NULL,
    `progress` INTEGER NOT NULL DEFAULT 0,
    `message` VARCHAR(500) NULL,
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `maxAttempts` INTEGER NOT NULL DEFAULT 3,
    `payload` JSON NULL,
    `result` JSON NULL,
    `error` TEXT NULL,
    `entityType` VARCHAR(40) NULL,
    `entityId` VARCHAR(32) NULL,
    `cancelRequestedAt` DATETIME(3) NULL,
    `startedAt` DATETIME(3) NULL,
    `heartbeatAt` DATETIME(3) NULL,
    `finishedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `background_job_records_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    INDEX `background_job_records_status_type_idx`(`status`, `type`),
    INDEX `background_job_records_status_heartbeatAt_idx`(`status`, `heartbeatAt`),
    INDEX `background_job_records_entityType_entityId_idx`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(32) NOT NULL,
    `workspaceId` VARCHAR(32) NULL,
    `actorUserId` VARCHAR(32) NULL,
    `action` VARCHAR(80) NOT NULL,
    `targetType` VARCHAR(40) NULL,
    `targetId` VARCHAR(64) NULL,
    `ipAddress` VARCHAR(64) NULL,
    `userAgent` VARCHAR(400) NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_workspaceId_createdAt_idx`(`workspaceId`, `createdAt`),
    INDEX `audit_logs_actorUserId_createdAt_idx`(`actorUserId`, `createdAt`),
    INDEX `audit_logs_action_createdAt_idx`(`action`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `email_deliveries` (
    `id` VARCHAR(32) NOT NULL,
    `userId` VARCHAR(32) NULL,
    `toAddress` VARCHAR(254) NOT NULL,
    `template` VARCHAR(60) NOT NULL,
    `subject` VARCHAR(255) NOT NULL,
    `status` ENUM('QUEUED', 'SENT', 'LOGGED_LOCALLY', 'FAILED') NOT NULL DEFAULT 'QUEUED',
    `provider` VARCHAR(30) NOT NULL,
    `providerMessageId` VARCHAR(255) NULL,
    `localPath` VARCHAR(500) NULL,
    `error` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,

    INDEX `email_deliveries_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `email_deliveries_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `contact_messages` (
    `id` VARCHAR(32) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `company` VARCHAR(160) NULL,
    `topic` VARCHAR(40) NOT NULL,
    `message` TEXT NOT NULL,
    `ipHash` CHAR(64) NOT NULL,
    `handledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `contact_messages_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_tokens` ADD CONSTRAINT `user_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_members` ADD CONSTRAINT `workspace_members_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_invitations` ADD CONSTRAINT `workspace_invitations_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `workspace_invitations` ADD CONSTRAINT `workspace_invitations_invitedById_fkey` FOREIGN KEY (`invitedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `projects` ADD CONSTRAINT `projects_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_competitors` ADD CONSTRAINT `project_competitors_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `competitor_snapshots` ADD CONSTRAINT `competitor_snapshots_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `competitor_snapshots` ADD CONSTRAINT `competitor_snapshots_competitorId_fkey` FOREIGN KEY (`competitorId`) REFERENCES `project_competitors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `crawl_jobs` ADD CONSTRAINT `crawl_jobs_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `crawled_pages` ADD CONSTRAINT `crawled_pages_crawlJobId_fkey` FOREIGN KEY (`crawlJobId`) REFERENCES `crawl_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `crawled_links` ADD CONSTRAINT `crawled_links_crawlJobId_fkey` FOREIGN KEY (`crawlJobId`) REFERENCES `crawl_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `crawled_links` ADD CONSTRAINT `crawled_links_fromPageId_fkey` FOREIGN KEY (`fromPageId`) REFERENCES `crawled_pages`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_runs` ADD CONSTRAINT `audit_runs_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_runs` ADD CONSTRAINT `audit_runs_crawlJobId_fkey` FOREIGN KEY (`crawlJobId`) REFERENCES `crawl_jobs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_issues` ADD CONSTRAINT `audit_issues_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_issue_occurrences` ADD CONSTRAINT `audit_issue_occurrences_auditRunId_fkey` FOREIGN KEY (`auditRunId`) REFERENCES `audit_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_issue_occurrences` ADD CONSTRAINT `audit_issue_occurrences_issueId_fkey` FOREIGN KEY (`issueId`) REFERENCES `audit_issues`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_issue_occurrences` ADD CONSTRAINT `audit_issue_occurrences_crawledPageId_fkey` FOREIGN KEY (`crawledPageId`) REFERENCES `crawled_pages`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `public_audits` ADD CONSTRAINT `public_audits_crawlJobId_fkey` FOREIGN KEY (`crawlJobId`) REFERENCES `crawl_jobs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_prompts` ADD CONSTRAINT `ai_prompts_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_prompt_competitors` ADD CONSTRAINT `ai_prompt_competitors_promptId_fkey` FOREIGN KEY (`promptId`) REFERENCES `ai_prompts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_prompt_competitors` ADD CONSTRAINT `ai_prompt_competitors_competitorId_fkey` FOREIGN KEY (`competitorId`) REFERENCES `project_competitors`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_visibility_runs` ADD CONSTRAINT `ai_visibility_runs_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_visibility_observations` ADD CONSTRAINT `ai_visibility_observations_runId_fkey` FOREIGN KEY (`runId`) REFERENCES `ai_visibility_runs`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_visibility_observations` ADD CONSTRAINT `ai_visibility_observations_promptId_fkey` FOREIGN KEY (`promptId`) REFERENCES `ai_prompts`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_visibility_observations` ADD CONSTRAINT `ai_visibility_observations_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `brand_mentions` ADD CONSTRAINT `brand_mentions_observationId_fkey` FOREIGN KEY (`observationId`) REFERENCES `ai_visibility_observations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `brand_mentions` ADD CONSTRAINT `brand_mentions_competitorId_fkey` FOREIGN KEY (`competitorId`) REFERENCES `project_competitors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_citations` ADD CONSTRAINT `ai_citations_observationId_fkey` FOREIGN KEY (`observationId`) REFERENCES `ai_visibility_observations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ai_citations` ADD CONSTRAINT `ai_citations_competitorId_fkey` FOREIGN KEY (`competitorId`) REFERENCES `project_competitors`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_briefs` ADD CONSTRAINT `content_briefs_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_documents` ADD CONSTRAINT `content_documents_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_documents` ADD CONSTRAINT `content_documents_briefId_fkey` FOREIGN KEY (`briefId`) REFERENCES `content_briefs`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_documents` ADD CONSTRAINT `content_documents_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_documents` ADD CONSTRAINT `content_documents_approvedById_fkey` FOREIGN KEY (`approvedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_versions` ADD CONSTRAINT `content_versions_documentId_fkey` FOREIGN KEY (`documentId`) REFERENCES `content_documents`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `content_versions` ADD CONSTRAINT `content_versions_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `keyword_lists` ADD CONSTRAINT `keyword_lists_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `topic_clusters` ADD CONSTRAINT `topic_clusters_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_keywords` ADD CONSTRAINT `project_keywords_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_keywords` ADD CONSTRAINT `project_keywords_listId_fkey` FOREIGN KEY (`listId`) REFERENCES `keyword_lists`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `project_keywords` ADD CONSTRAINT `project_keywords_clusterId_fkey` FOREIGN KEY (`clusterId`) REFERENCES `topic_clusters`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recommendations` ADD CONSTRAINT `recommendations_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `recommendations` ADD CONSTRAINT `recommendations_assigneeId_fkey` FOREIGN KEY (`assigneeId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `integrations` ADD CONSTRAINT `integrations_connectedById_fkey` FOREIGN KEY (`connectedById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `oauth_tokens` ADD CONSTRAINT `oauth_tokens_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `oauth_states` ADD CONSTRAINT `oauth_states_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `search_console_metrics` ADD CONSTRAINT `search_console_metrics_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `search_console_metrics` ADD CONSTRAINT `search_console_metrics_integrationId_fkey` FOREIGN KEY (`integrationId`) REFERENCES `integrations`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `subscriptions` ADD CONSTRAINT `subscriptions_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `subscription_plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `billing_invoices` ADD CONSTRAINT `billing_invoices_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `billing_invoices` ADD CONSTRAINT `billing_invoices_subscriptionId_fkey` FOREIGN KEY (`subscriptionId`) REFERENCES `subscriptions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `usage_records` ADD CONSTRAINT `usage_records_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `usage_records` ADD CONSTRAINT `usage_records_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reports` ADD CONSTRAINT `reports_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reports` ADD CONSTRAINT `reports_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `reports` ADD CONSTRAINT `reports_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `notifications` ADD CONSTRAINT `notifications_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `background_job_records` ADD CONSTRAINT `background_job_records_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `background_job_records` ADD CONSTRAINT `background_job_records_projectId_fkey` FOREIGN KEY (`projectId`) REFERENCES `projects`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `background_job_records` ADD CONSTRAINT `background_job_records_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_workspaceId_fkey` FOREIGN KEY (`workspaceId`) REFERENCES `workspaces`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_actorUserId_fkey` FOREIGN KEY (`actorUserId`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;
