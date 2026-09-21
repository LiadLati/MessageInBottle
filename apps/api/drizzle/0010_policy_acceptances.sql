CREATE TABLE `policy_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`document` text NOT NULL,
	`version` text NOT NULL,
	`action` text NOT NULL,
	`source` text NOT NULL,
	`accepted_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `policy_acceptances_user_idx` ON `policy_acceptances` (`user_id`,`document`,`accepted_at`);