CREATE TABLE `bottle_outcome_views` (
	`user_id` text NOT NULL,
	`bottle_id` text NOT NULL,
	`seen_at` integer,
	`acknowledged_at` integer,
	PRIMARY KEY(`user_id`, `bottle_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `bottles` ADD `outcome_at` integer;--> statement-breakpoint
ALTER TABLE `bottles` ADD `outcome_progress` real;--> statement-breakpoint
ALTER TABLE `bottles` ADD `outcome_chart_x` integer;--> statement-breakpoint
ALTER TABLE `bottles` ADD `outcome_chart_y` integer;--> statement-breakpoint
ALTER TABLE `bottles` ADD `outcome_lng` real;--> statement-breakpoint
ALTER TABLE `bottles` ADD `outcome_lat` real;