CREATE TABLE `icp_knowledge_base` (
	`industry` text PRIMARY KEY NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`best_practices` text DEFAULT '' NOT NULL,
	`workflow_notes` text DEFAULT '' NOT NULL,
	`terminology_notes` text DEFAULT '' NOT NULL,
	`tone_refinement` text DEFAULT '' NOT NULL,
	`notification_refinement` text DEFAULT '' NOT NULL,
	`compliance_notes` text DEFAULT '' NOT NULL,
	`sources` text DEFAULT '' NOT NULL,
	`researched_by` text DEFAULT '' NOT NULL,
	`researched_at` integer,
	`updated_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
