ALTER TABLE `bookings` ADD `signature_url` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `signature_name` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `bookings` ADD `signed_at` integer;--> statement-breakpoint
ALTER TABLE `job_photos` ADD `phase` text DEFAULT 'during' NOT NULL;--> statement-breakpoint
ALTER TABLE `job_photos` ADD `customer_visible` integer DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `jobphoto_phase_idx` ON `job_photos` (`booking_id`,`phase`);