CREATE TABLE `booking_change_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`booking_id` text NOT NULL,
	`requested_by` text DEFAULT '' NOT NULL,
	`requested_by_name` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text DEFAULT '' NOT NULL,
	`proposed_at` integer,
	`previous_at` integer,
	`decided_by` text DEFAULT '' NOT NULL,
	`decided_by_name` text DEFAULT '' NOT NULL,
	`decided_at` integer,
	`decision_note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chgreq_company_idx` ON `booking_change_requests` (`company_id`);--> statement-breakpoint
CREATE INDEX `chgreq_booking_idx` ON `booking_change_requests` (`booking_id`);--> statement-breakpoint
CREATE INDEX `chgreq_status_idx` ON `booking_change_requests` (`company_id`,`status`);--> statement-breakpoint
ALTER TABLE `company_settings` ADD `allow_customer_reschedule` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `allow_customer_cancel_request` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `customer_change_cutoff_hours` integer DEFAULT 12 NOT NULL;