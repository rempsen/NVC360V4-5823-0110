CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`hashed_key` text NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`scopes` text DEFAULT '' NOT NULL,
	`key_type` text DEFAULT 'secret' NOT NULL,
	`public_key` text DEFAULT '' NOT NULL,
	`allowed_origins` text DEFAULT '' NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`created_by_name` text DEFAULT '' NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `apikey_company_idx` ON `api_keys` (`company_id`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`filename` text NOT NULL,
	`url` text NOT NULL,
	`storage_key` text DEFAULT '' NOT NULL,
	`mime` text DEFAULT '' NOT NULL,
	`size` integer DEFAULT 0 NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`uploaded_by` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `attach_company_idx` ON `attachments` (`company_id`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`actor_id` text DEFAULT '' NOT NULL,
	`actor_name` text DEFAULT '' NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text DEFAULT '' NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_entity_idx` ON `audit_log` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `audit_actor_idx` ON `audit_log` (`actor_id`);--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_log` (`created_at`);--> statement-breakpoint
CREATE INDEX `audit_company_idx` ON `audit_log` (`company_id`);--> statement-breakpoint
CREATE TABLE `automation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`trigger` text NOT NULL,
	`conditions` text DEFAULT '{}' NOT NULL,
	`action` text NOT NULL,
	`action_config` text DEFAULT '{}' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`runs_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `autorule_company_idx` ON `automation_rules` (`company_id`);--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`customer_id` text NOT NULL,
	`service_id` text NOT NULL,
	`rider_id` text,
	`template_id` text,
	`title` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`scheduled_at` integer NOT NULL,
	`address` text NOT NULL,
	`lat` real DEFAULT 43.6532 NOT NULL,
	`lng` real DEFAULT -79.3832 NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`staff_notes` text DEFAULT '' NOT NULL,
	`driver_notes` text DEFAULT '' NOT NULL,
	`field_data` text DEFAULT '{}' NOT NULL,
	`checklist_state` text DEFAULT '[]' NOT NULL,
	`price` real DEFAULT 0 NOT NULL,
	`rate_model` text DEFAULT '' NOT NULL,
	`line_items` text DEFAULT '[]' NOT NULL,
	`line_items_cost` real DEFAULT 0 NOT NULL,
	`line_items_price` real DEFAULT 0 NOT NULL,
	`region` text DEFAULT '' NOT NULL,
	`subtotal` real DEFAULT 0 NOT NULL,
	`tax_amount` real DEFAULT 0 NOT NULL,
	`tax_rate_pct` real DEFAULT 0 NOT NULL,
	`tax_label` text DEFAULT '' NOT NULL,
	`total` real DEFAULT 0 NOT NULL,
	`price_breakdown` text DEFAULT '' NOT NULL,
	`enroute_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`on_site_minutes` real DEFAULT 0 NOT NULL,
	`transit_minutes` real DEFAULT 0 NOT NULL,
	`clock_state` text DEFAULT 'idle' NOT NULL,
	`accumulated_ms` integer DEFAULT 0 NOT NULL,
	`last_resume_at` integer,
	`inside_geofence` integer DEFAULT false NOT NULL,
	`mileage_km` real DEFAULT 0 NOT NULL,
	`tech_pay` real DEFAULT 0 NOT NULL,
	`tech_pay_breakdown` text DEFAULT '' NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`public_token` text NOT NULL,
	`customer_phone` text DEFAULT '' NOT NULL,
	`sms_sent_at` integer,
	`token_expires_at` integer,
	`eta_mins` integer,
	`eta_distance_km` real,
	`assign_status` text DEFAULT 'none' NOT NULL,
	`assigned_at` integer,
	`accepted_at` integer,
	`decline_reason` text DEFAULT '' NOT NULL,
	`required_skill_class` text DEFAULT '' NOT NULL,
	`required_skills` text DEFAULT '' NOT NULL,
	`deleted_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`service_id`) REFERENCES `services`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rider_id`) REFERENCES `riders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_id`) REFERENCES `task_templates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bk_company_idx` ON `bookings` (`company_id`);--> statement-breakpoint
CREATE INDEX `bk_status_idx` ON `bookings` (`status`);--> statement-breakpoint
CREATE INDEX `bk_sched_idx` ON `bookings` (`scheduled_at`);--> statement-breakpoint
CREATE INDEX `bk_finished_idx` ON `bookings` (`finished_at`);--> statement-breakpoint
CREATE INDEX `bk_rider_idx` ON `bookings` (`rider_id`);--> statement-breakpoint
CREATE INDEX `bk_customer_idx` ON `bookings` (`customer_id`);--> statement-breakpoint
CREATE INDEX `bk_service_idx` ON `bookings` (`service_id`);--> statement-breakpoint
CREATE INDEX `bk_paystatus_idx` ON `bookings` (`payment_status`);--> statement-breakpoint
CREATE INDEX `bk_priority_idx` ON `bookings` (`priority`);--> statement-breakpoint
CREATE INDEX `bk_region_idx` ON `bookings` (`region`);--> statement-breakpoint
CREATE INDEX `bk_deleted_idx` ON `bookings` (`deleted_at`);--> statement-breakpoint
CREATE INDEX `bk_created_idx` ON `bookings` (`created_at`);--> statement-breakpoint
CREATE TABLE `catalog_items` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`kind` text DEFAULT 'product' NOT NULL,
	`name` text NOT NULL,
	`sku` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'General' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`image` text DEFAULT '' NOT NULL,
	`unit` text DEFAULT 'each' NOT NULL,
	`unit_cost` real DEFAULT 0 NOT NULL,
	`markup_pct` real DEFAULT 0 NOT NULL,
	`price_mode` text DEFAULT 'auto' NOT NULL,
	`unit_price` real DEFAULT 0 NOT NULL,
	`taxable` integer DEFAULT true NOT NULL,
	`components` text DEFAULT '[]' NOT NULL,
	`service_id` text,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `catalog_company_idx` ON `catalog_items` (`company_id`);--> statement-breakpoint
CREATE TABLE `companies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`contact_email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`plan` text DEFAULT 'starter' NOT NULL,
	`industry` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `company_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text DEFAULT 'NVC 360' NOT NULL,
	`legal_name` text DEFAULT '' NOT NULL,
	`email` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '423 Main Street, Winnipeg, Manitoba, Canada' NOT NULL,
	`lat` real DEFAULT 49.8951 NOT NULL,
	`lng` real DEFAULT -97.1384 NOT NULL,
	`timezone` text DEFAULT 'America/Winnipeg' NOT NULL,
	`currency` text DEFAULT 'CAD' NOT NULL,
	`tax_rate` real DEFAULT 5 NOT NULL,
	`tax_label` text DEFAULT 'GST' NOT NULL,
	`default_region` text DEFAULT 'MB' NOT NULL,
	`auto_tax_by_region` integer DEFAULT true NOT NULL,
	`logo` text DEFAULT '' NOT NULL,
	`logo_source_url` text DEFAULT '' NOT NULL,
	`brand_color` text DEFAULT '#06B6D4' NOT NULL,
	`accent_color` text DEFAULT '' NOT NULL,
	`worker_noun` text DEFAULT 'Technician' NOT NULL,
	`worker_noun_plural` text DEFAULT 'Technicians' NOT NULL,
	`tagline` text DEFAULT '' NOT NULL,
	`hours` text DEFAULT '' NOT NULL,
	`services` text DEFAULT '' NOT NULL,
	`socials` text DEFAULT '' NOT NULL,
	`geofence_radius_m` integer DEFAULT 150 NOT NULL,
	`website` text DEFAULT '' NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `settings_company_idx` ON `company_settings` (`company_id`);--> statement-breakpoint
CREATE TABLE `custom_field_values` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`field_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`value` text DEFAULT '' NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`field_id`) REFERENCES `custom_fields`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `cfv_company_idx` ON `custom_field_values` (`company_id`);--> statement-breakpoint
CREATE TABLE `custom_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`entity` text NOT NULL,
	`label` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`placeholder` text DEFAULT '' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`section` text DEFAULT 'General' NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cf_company_idx` ON `custom_fields` (`company_id`);--> statement-breakpoint
CREATE TABLE `email_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text DEFAULT 'Untitled template' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`subject` text DEFAULT '' NOT NULL,
	`design` text DEFAULT '[]' NOT NULL,
	`is_builtin` integer DEFAULT false NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `emailtpl_company_idx` ON `email_templates` (`company_id`);--> statement-breakpoint
CREATE TABLE `entity_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`tag_id` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `etags_company_idx` ON `entity_tags` (`company_id`);--> statement-breakpoint
CREATE TABLE `form_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `form_categories_company_idx` ON `form_categories` (`company_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`key` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'payment' NOT NULL,
	`response_status` integer,
	`response_body` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `intake_forms` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`slug` text NOT NULL,
	`title` text DEFAULT 'Request Service' NOT NULL,
	`intro` text DEFAULT '' NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`sections` text DEFAULT '[]' NOT NULL,
	`recipient_name` text DEFAULT '' NOT NULL,
	`recipient_email` text DEFAULT '' NOT NULL,
	`public_key_id` text DEFAULT '' NOT NULL,
	`brand_color` text DEFAULT '#06b6d4' NOT NULL,
	`logo_url` text DEFAULT '' NOT NULL,
	`success_message` text DEFAULT 'Thanks! We''ve received your request and will reach out shortly.' NOT NULL,
	`default_service_id` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`submit_count` integer DEFAULT 0 NOT NULL,
	`created_by` text DEFAULT '' NOT NULL,
	`form_type` text DEFAULT 'lead' NOT NULL,
	`access_code` text DEFAULT '' NOT NULL,
	`allow_tech_assign` integer DEFAULT true NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intake_company_idx` ON `intake_forms` (`company_id`);--> statement-breakpoint
CREATE INDEX `intake_slug_idx` ON `intake_forms` (`company_id`,`slug`);--> statement-breakpoint
CREATE TABLE `intake_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`form_id` text DEFAULT '' NOT NULL,
	`booking_id` text DEFAULT '' NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`ip_hash` text DEFAULT '' NOT NULL,
	`origin` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `intakesub_company_idx` ON `intake_submissions` (`company_id`);--> statement-breakpoint
CREATE INDEX `intakesub_form_idx` ON `intake_submissions` (`form_id`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`provider` text NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`account_label` text DEFAULT '' NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`access_token` text DEFAULT '' NOT NULL,
	`refresh_token` text DEFAULT '' NOT NULL,
	`expires_at` integer,
	`scope` text DEFAULT '' NOT NULL,
	`external_account_id` text DEFAULT '' NOT NULL,
	`last_sync_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `integ_company_idx` ON `integrations` (`company_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`booking_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`number` text NOT NULL,
	`amount` real NOT NULL,
	`tax` real DEFAULT 0 NOT NULL,
	`total` real NOT NULL,
	`status` text DEFAULT 'unpaid' NOT NULL,
	`method` text DEFAULT 'card' NOT NULL,
	`paid_at` integer,
	`stripe_payment_intent_id` text,
	`stripe_charge_id` text,
	`amount_refunded` real DEFAULT 0 NOT NULL,
	`currency` text DEFAULT 'cad' NOT NULL,
	`last_payment_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `inv_company_idx` ON `invoices` (`company_id`);--> statement-breakpoint
CREATE INDEX `inv_booking_idx` ON `invoices` (`booking_id`);--> statement-breakpoint
CREATE INDEX `inv_pi_idx` ON `invoices` (`stripe_payment_intent_id`);--> statement-breakpoint
CREATE TABLE `job_photos` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`booking_id` text NOT NULL,
	`url` text NOT NULL,
	`caption` text DEFAULT '' NOT NULL,
	`source` text DEFAULT 'companycam' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `jobphoto_company_idx` ON `job_photos` (`company_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`booking_id` text,
	`rider_id` text,
	`sender_role` text NOT NULL,
	`sender_name` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`channel` text DEFAULT 'app' NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rider_id`) REFERENCES `riders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `msg_company_idx` ON `messages` (`company_id`);--> statement-breakpoint
CREATE TABLE `notification_channels` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`in_app_enabled` integer DEFAULT true NOT NULL,
	`email_enabled` integer DEFAULT true NOT NULL,
	`sms_enabled` integer DEFAULT true NOT NULL,
	`webhook_enabled` integer DEFAULT true NOT NULL,
	`email_from_name` text DEFAULT 'NVC 360' NOT NULL,
	`email_from_address` text DEFAULT '' NOT NULL,
	`email_reply_to` text DEFAULT '' NOT NULL,
	`email_footer` text DEFAULT '' NOT NULL,
	`email_body_template` text DEFAULT '' NOT NULL,
	`sms_body_template` text DEFAULT '' NOT NULL,
	`sms_from_number` text DEFAULT '' NOT NULL,
	`sms_sender_id` text DEFAULT '' NOT NULL,
	`quiet_hours_enabled` integer DEFAULT false NOT NULL,
	`quiet_start` text DEFAULT '21:00' NOT NULL,
	`quiet_end` text DEFAULT '08:00' NOT NULL,
	`quiet_channels` text DEFAULT 'sms,email' NOT NULL,
	`email_logo_url` text DEFAULT '' NOT NULL,
	`email_brand_color` text DEFAULT '#06B6D4' NOT NULL,
	`email_header_style` text DEFAULT 'gradient' NOT NULL,
	`email_bg_color` text DEFAULT '#f1f5f9' NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifchan_company_idx` ON `notification_channels` (`company_id`);--> statement-breakpoint
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`event` text NOT NULL,
	`booking_id` text,
	`recipient` text NOT NULL,
	`channel` text NOT NULL,
	`target` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'sent' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifdeliv_company_idx` ON `notification_deliveries` (`company_id`);--> statement-breakpoint
CREATE TABLE `notification_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`event` text NOT NULL,
	`recipient` text NOT NULL,
	`in_app` integer DEFAULT true NOT NULL,
	`email` integer DEFAULT false NOT NULL,
	`sms` integer DEFAULT false NOT NULL,
	`webhook` integer DEFAULT false NOT NULL,
	`template` text DEFAULT '' NOT NULL,
	`email_subject` text DEFAULT '' NOT NULL,
	`email_design` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifrule_company_idx` ON `notification_rules` (`company_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`user_id` text NOT NULL,
	`booking_id` text,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`read` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notif_company_idx` ON `notifications` (`company_id`);--> statement-breakpoint
CREATE TABLE `oauth_app_credentials` (
	`provider` text PRIMARY KEY NOT NULL,
	`client_id` text DEFAULT '' NOT NULL,
	`client_secret` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`updated_by` text DEFAULT '' NOT NULL,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `payment_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`invoice_id` text,
	`booking_id` text,
	`kind` text NOT NULL,
	`amount` real NOT NULL,
	`currency` text DEFAULT 'cad' NOT NULL,
	`stripe_object_id` text,
	`status` text NOT NULL,
	`memo` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ledger_company_idx` ON `payment_ledger` (`company_id`);--> statement-breakpoint
CREATE INDEX `ledger_invoice_idx` ON `payment_ledger` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `ledger_booking_idx` ON `payment_ledger` (`booking_id`);--> statement-breakpoint
CREATE TABLE `payouts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`rider_id` text NOT NULL,
	`period_start` integer NOT NULL,
	`period_end` integer NOT NULL,
	`jobs_count` integer DEFAULT 0 NOT NULL,
	`gross` real DEFAULT 0 NOT NULL,
	`fee_pct` real DEFAULT 20 NOT NULL,
	`fee` real DEFAULT 0 NOT NULL,
	`net` real DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`paid_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`rider_id`) REFERENCES `riders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payout_company_idx` ON `payouts` (`company_id`);--> statement-breakpoint
CREATE TABLE `push_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`user_id` text NOT NULL,
	`token` text NOT NULL,
	`platform` text DEFAULT 'ios' NOT NULL,
	`device_name` text DEFAULT '' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_tokens_token_unique` ON `push_tokens` (`token`);--> statement-breakpoint
CREATE INDEX `push_tokens_user_idx` ON `push_tokens` (`user_id`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`booking_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`rider_id` text,
	`rating` integer NOT NULL,
	`comment` text DEFAULT '' NOT NULL,
	`hidden` integer DEFAULT false NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`reply` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rider_id`) REFERENCES `riders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_company_idx` ON `reviews` (`company_id`);--> statement-breakpoint
CREATE TABLE `riders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`vehicle` text DEFAULT 'Van' NOT NULL,
	`skills` text DEFAULT '' NOT NULL,
	`skill_class` text DEFAULT 'General' NOT NULL,
	`color` text DEFAULT '#0ea5e9' NOT NULL,
	`photo_url` text DEFAULT '' NOT NULL,
	`photo_key` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`license_plate` text DEFAULT '' NOT NULL,
	`license_number` text DEFAULT '' NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'offline' NOT NULL,
	`manual_offline` integer DEFAULT false NOT NULL,
	`pay_rate_per_hour` real DEFAULT 0 NOT NULL,
	`rating` real DEFAULT 4.9 NOT NULL,
	`completed_jobs` integer DEFAULT 0 NOT NULL,
	`approval` text DEFAULT 'active' NOT NULL,
	`invited_at` integer,
	`lat` real,
	`lng` real,
	`location_updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `riders_company_idx` ON `riders` (`company_id`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role` text PRIMARY KEY NOT NULL,
	`perms` text DEFAULT '[]' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `service_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT '#06B6D4' NOT NULL,
	`polygon` text DEFAULT '[]' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`surge_multiplier` real DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `zone_company_idx` ON `service_zones` (`company_id`);--> statement-breakpoint
CREATE TABLE `services` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`category` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`icon` text DEFAULT 'wrench' NOT NULL,
	`image` text DEFAULT '' NOT NULL,
	`base_price` real DEFAULT 0 NOT NULL,
	`duration_mins` integer DEFAULT 60 NOT NULL,
	`rate_model` text DEFAULT '' NOT NULL,
	`rating` real DEFAULT 4.8 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `services_company_idx` ON `services` (`company_id`);--> statement-breakpoint
CREATE TABLE `skill_library` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'General' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `skill_company_idx` ON `skill_library` (`company_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`label` text NOT NULL,
	`color` text DEFAULT '#06B6D4' NOT NULL,
	`scope` text DEFAULT 'both' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tags_company_idx` ON `tags` (`company_id`);--> statement-breakpoint
CREATE TABLE `task_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`name` text NOT NULL,
	`category` text DEFAULT 'General' NOT NULL,
	`icon` text DEFAULT 'clipboard-list' NOT NULL,
	`color` text DEFAULT '#0ea5e9' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`checklist` text DEFAULT '[]' NOT NULL,
	`estimated_mins` integer DEFAULT 60 NOT NULL,
	`rate_model` text DEFAULT '' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tasktpl_company_idx` ON `task_templates` (`company_id`);--> statement-breakpoint
CREATE TABLE `tech_invites` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`email` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`phone` text DEFAULT '' NOT NULL,
	`skill_class` text DEFAULT 'General' NOT NULL,
	`token` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`invited_by` text DEFAULT '' NOT NULL,
	`accepted_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `techinvite_company_idx` ON `tech_invites` (`company_id`);--> statement-breakpoint
CREATE TABLE `tech_shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`rider_id` text NOT NULL,
	`kind` text DEFAULT 'shift' NOT NULL,
	`date` integer NOT NULL,
	`start_min` integer DEFAULT 540 NOT NULL,
	`end_min` integer DEFAULT 1020 NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`rider_id`) REFERENCES `riders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `shift_company_idx` ON `tech_shifts` (`company_id`);--> statement-breakpoint
CREATE TABLE `tenant_email_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`domain` text NOT NULL,
	`resend_domain_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`region` text DEFAULT 'eu-west-1' NOT NULL,
	`records` text DEFAULT '[]' NOT NULL,
	`last_checked_at` integer,
	`created_by` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ted_company_idx` ON `tenant_email_domains` (`company_id`);--> statement-breakpoint
CREATE TABLE `tracking_pings` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`booking_id` text NOT NULL,
	`lat` real NOT NULL,
	`lng` real NOT NULL,
	`phase` text DEFAULT 'enroute' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tp_booking_created_idx` ON `tracking_pings` (`booking_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tp_created_idx` ON `tracking_pings` (`created_at`);--> statement-breakpoint
CREATE INDEX `tp_company_idx` ON `tracking_pings` (`company_id`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`company_id` text DEFAULT 'default' NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`url` text NOT NULL,
	`secret` text DEFAULT '' NOT NULL,
	`events` text DEFAULT '*' NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhook_company_idx` ON `webhook_endpoints` (`company_id`);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`role` text DEFAULT 'customer',
	`phone` text,
	`company_id` text DEFAULT 'default' NOT NULL,
	`alt_phone` text,
	`company` text,
	`address` text,
	`city` text,
	`region` text,
	`postal_code` text,
	`country` text,
	`notes` text,
	`addresses` text,
	`contacts` text,
	`calendar_token` text,
	`permissions` text,
	`staff_type` text,
	`manager_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);