CREATE TABLE `maintenance_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`customer_id` text,
	`property_id` text,
	`service_id` text,
	`address` text DEFAULT '' NOT NULL,
	`interval_days` integer DEFAULT 180 NOT NULL,
	`remind_days_before` integer DEFAULT 7 NOT NULL,
	`next_due_at` integer,
	`last_service_at` integer,
	`notes` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`reminders_sent` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mplan_company_idx` ON `maintenance_plans` (`company_id`);--> statement-breakpoint
CREATE INDEX `mplan_due_idx` ON `maintenance_plans` (`active`,`next_due_at`);--> statement-breakpoint
CREATE INDEX `mplan_prop_idx` ON `maintenance_plans` (`property_id`);--> statement-breakpoint
ALTER TABLE `company_settings` ADD `review_request_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `review_request_delay_mins` integer DEFAULT 120 NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `google_review_url` text DEFAULT '' NOT NULL;