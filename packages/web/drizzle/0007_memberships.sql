CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`company_id` text NOT NULL,
	`role` text DEFAULT 'customer' NOT NULL,
	`permissions` text,
	`staff_type` text,
	`manager_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`invited_by` text,
	`accepted_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_user_company_uidx` ON `memberships` (`user_id`,`company_id`);--> statement-breakpoint
CREATE INDEX `memberships_company_idx` ON `memberships` (`company_id`);--> statement-breakpoint
CREATE INDEX `memberships_user_idx` ON `memberships` (`user_id`);