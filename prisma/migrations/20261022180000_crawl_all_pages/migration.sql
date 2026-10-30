-- Audits crawl every reachable page by default (page and depth caps become optional, null = no cap).
-- Only values that are the previous built-in defaults are cleared, so caps someone chose on purpose are kept.

-- Default plans: previous built-in page caps per audit.
UPDATE `subscription_plans`
SET `limits` = JSON_SET(`limits`, '$.pagesPerAudit', CAST('null' AS JSON))
WHERE `key` IN ('FREE', 'STARTER', 'GROWTH', 'AGENCY')
  AND JSON_EXTRACT(`limits`, '$.pagesPerAudit') IN (50, 500, 2000, 5000);

-- Projects: the previous default (100 pages, depth 4) or a value clamped to a previous plan cap, with depth 4.
UPDATE `projects`
SET `crawlSettings` = JSON_SET(`crawlSettings`, '$.maxPages', CAST('null' AS JSON), '$.maxDepth', CAST('null' AS JSON))
WHERE JSON_EXTRACT(`crawlSettings`, '$.maxPages') IN (50, 100, 500, 2000, 5000)
  AND JSON_EXTRACT(`crawlSettings`, '$.maxDepth') = 4;
