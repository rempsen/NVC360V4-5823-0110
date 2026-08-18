ALTER TABLE `payouts` ADD `hourly_pay` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payouts` ADD `unit_pay` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payouts` ADD `on_site_minutes` real DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payouts` ADD `unrated_jobs` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `payouts` ADD `breakdown` text DEFAULT '' NOT NULL;