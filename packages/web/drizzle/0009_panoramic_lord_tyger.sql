ALTER TABLE `messages` ADD `read_by_tech` integer DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX `msg_tech_unread_idx` ON `messages` (`booking_id`,`read_by_tech`);--> statement-breakpoint
--
-- Backfill: treat everything that already exists as ALREADY SEEN by the field.
--
-- The column defaults to false, so without this every historical job-thread
-- message becomes "unread by tech" the moment this ships — a technician with a
-- year of job history opens the app to a badge in the hundreds that reflects
-- nothing they need to do. That is precisely the "badge you can't clear"
-- failure this column exists to avoid.
--
-- Starting from zero means the count only ever reflects messages sent AFTER
-- this migration, which is the only number a tech can act on.
UPDATE `messages` SET `read_by_tech` = true;
