-- How a scan's result order was obtained (observed_search_position, discovery_order, estimated_visibility).
-- Nullable and additive: existing scans keep NULL and are treated as the per-source default at read time.
ALTER TABLE `local_rank_scans` ADD COLUMN `observationType` VARCHAR(40) NULL;
