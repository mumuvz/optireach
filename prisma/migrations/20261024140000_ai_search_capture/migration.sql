-- AlterTable
ALTER TABLE `ai_prompts` ADD COLUMN `city` VARCHAR(120) NULL;

-- AlterTable
ALTER TABLE `ai_visibility_observations` ADD COLUMN `captureMethod` VARCHAR(20) NOT NULL DEFAULT 'API',
    ADD COLUMN `capturedById` VARCHAR(32) NULL,
    ADD COLUMN `city` VARCHAR(120) NULL,
    ADD COLUMN `limitations` JSON NULL,
    ADD COLUMN `note` VARCHAR(1000) NULL;


-- Existing observations: demo fixtures were not real AI output; everything else came from an official API.
UPDATE `ai_visibility_observations` SET `captureMethod` = 'DEMO' WHERE `isDemo` = true;
