CREATE TABLE `public_openings` (
	`bottle_id` text PRIMARY KEY NOT NULL,
	`opened_by_id` text NOT NULL,
	`opened_at` integer NOT NULL,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`opened_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `public_openings_opener_idx` ON `public_openings` (`opened_by_id`,`opened_at`);