ALTER TABLE `bookings` ADD `delay_flagged_at` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `delay_flagged_mins` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `delay_notified_at` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `delay_notified_mins` integer;--> statement-breakpoint
ALTER TABLE `bookings` ADD `delay_muted` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `delay_notice_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `delay_notice_threshold_mins` integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `delay_notice_auto_send_after_mins` integer DEFAULT 10 NOT NULL;