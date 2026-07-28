CREATE TABLE `booking_option_selections` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`booking_id` text NOT NULL,
	`category_id` text NOT NULL,
	`category_name` text DEFAULT '' NOT NULL,
	`item_id` text NOT NULL,
	`item_name` text DEFAULT '' NOT NULL,
	`tier_label` text DEFAULT '' NOT NULL,
	`price_delta` real DEFAULT 0 NOT NULL,
	`selected_by` text DEFAULT 'customer' NOT NULL,
	`signature_name` text DEFAULT '' NOT NULL,
	`selected_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `optsel_booking_idx` ON `booking_option_selections` (`booking_id`);--> statement-breakpoint
CREATE INDEX `optsel_company_idx` ON `booking_option_selections` (`company_id`);--> statement-breakpoint
CREATE TABLE `option_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `optcat_company_idx` ON `option_categories` (`company_id`);--> statement-breakpoint
CREATE TABLE `option_category_items` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`category_id` text NOT NULL,
	`tier_label` text DEFAULT '' NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`image` text DEFAULT '' NOT NULL,
	`price_delta` real DEFAULT 0 NOT NULL,
	`unit_cost` real DEFAULT 0 NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `option_categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `optitem_category_idx` ON `option_category_items` (`category_id`);--> statement-breakpoint
CREATE INDEX `optitem_company_idx` ON `option_category_items` (`company_id`);