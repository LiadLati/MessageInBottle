CREATE TABLE `account_zone_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`zone` text NOT NULL,
	`source` text NOT NULL,
	`effective_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_zone_changes_user_idx` ON `account_zone_changes` (`user_id`,`effective_at`);--> statement-breakpoint
CREATE TABLE `risk_policy_activations` (
	`version` integer PRIMARY KEY NOT NULL,
	`activated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `weather_rolls` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`policy_version` integer NOT NULL,
	`rolled_at` integer NOT NULL,
	`zone` text NOT NULL,
	`night_starts_at` integer NOT NULL,
	`night_ends_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`storm_starts_at` integer,
	`storm_ends_at` integer,
	`decision_at` integer,
	`decided_at` integer,
	`cancelled_at` integer,
	`cancel_reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weather_rolls_user_rolled_idx` ON `weather_rolls` (`user_id`,`rolled_at`);--> statement-breakpoint
CREATE INDEX `weather_rolls_pending_idx` ON `weather_rolls` (`outcome`,`decided_at`,`cancelled_at`,`decision_at`);