CREATE TABLE `job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`booking_id` text NOT NULL,
	`kind` text NOT NULL,
	`actor_role` text DEFAULT 'system' NOT NULL,
	`actor_name` text DEFAULT '' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`customer_visible` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobev_company_idx` ON `job_events` (`company_id`);--> statement-breakpoint
CREATE INDEX `jobev_booking_idx` ON `job_events` (`booking_id`);--> statement-breakpoint
CREATE INDEX `jobev_created_idx` ON `job_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `properties` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`address_normalized` text NOT NULL,
	`address_display` text DEFAULT '' NOT NULL,
	`lat` real,
	`lng` real,
	`customer_id` text,
	`public_token` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `prop_company_idx` ON `properties` (`company_id`);--> statement-breakpoint
CREATE INDEX `prop_addr_idx` ON `properties` (`company_id`,`address_normalized`);--> statement-breakpoint
CREATE INDEX `prop_token_idx` ON `properties` (`public_token`);--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`kind` text NOT NULL,
	`booking_id` text,
	`property_id` text,
	`run_at` integer NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`completed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`property_id`) REFERENCES `properties`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `schedtask_company_idx` ON `scheduled_tasks` (`company_id`);--> statement-breakpoint
CREATE INDEX `schedtask_due_idx` ON `scheduled_tasks` (`status`,`run_at`);--> statement-breakpoint
CREATE INDEX `schedtask_booking_idx` ON `scheduled_tasks` (`booking_id`);--> statement-breakpoint
ALTER TABLE `bookings` ADD `property_id` text;