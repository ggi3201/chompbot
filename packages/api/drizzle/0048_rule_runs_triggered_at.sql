-- The dashboard reads recent rule runs on every poll; this table grows by about 85k rows a month.
CREATE INDEX `proactive_rule_runs_triggered_at_idx` ON `proactive_rule_runs` (`triggered_at`);
