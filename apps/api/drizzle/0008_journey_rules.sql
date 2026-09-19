CREATE TABLE `risk_decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`bottle_id` text NOT NULL,
	`night_key` text NOT NULL,
	`policy_version` integer NOT NULL,
	`storm_starts_at` integer,
	`storm_ends_at` integer,
	`decision_at` integer NOT NULL,
	`eligible` integer NOT NULL,
	`lost` integer NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `risk_decisions_bottle_night_idx` ON `risk_decisions` (`bottle_id`,`night_key`);--> statement-breakpoint
ALTER TABLE `bottles` ADD `risk_policy_version` integer;--> statement-breakpoint
ALTER TABLE `bottles` ADD `public_deadline_at` integer;--> statement-breakpoint
ALTER TABLE `bottles` ADD `public_expired_at` integer;--> statement-breakpoint
ALTER TABLE `public_openings` ADD `session_expires_at` integer;--> statement-breakpoint
ALTER TABLE `public_openings` ADD `closed_at` integer;