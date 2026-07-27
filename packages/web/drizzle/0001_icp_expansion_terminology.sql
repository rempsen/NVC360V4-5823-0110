ALTER TABLE `companies` ADD `industry_other` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `customer_noun` text DEFAULT 'Customer' NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `customer_noun_plural` text DEFAULT 'Customers' NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `job_noun` text DEFAULT 'Job' NOT NULL;--> statement-breakpoint
ALTER TABLE `company_settings` ADD `job_noun_plural` text DEFAULT 'Jobs' NOT NULL;