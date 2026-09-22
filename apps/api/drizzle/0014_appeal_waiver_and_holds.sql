CREATE TABLE `moderation_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`case_id` text,
	`violation_id` text,
	`appeal_id` text,
	`subject_user_id` text,
	`actor_user_id` text,
	`actor_role` text NOT NULL,
	`reason` text,
	`detail` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `moderation_cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`violation_id`) REFERENCES `violations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`appeal_id`) REFERENCES `appeals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`subject_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `moderation_audit_case_idx` ON `moderation_audit` (`case_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `moderation_audit_subject_idx` ON `moderation_audit` (`subject_user_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `moderation_cases` ADD `hold_reason` text;--> statement-breakpoint
ALTER TABLE `moderation_cases` ADD `hold_note` text;--> statement-breakpoint
ALTER TABLE `moderation_cases` ADD `hold_by_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `moderation_cases` ADD `hold_at` integer;--> statement-breakpoint
ALTER TABLE `moderation_cases` ADD `hold_released_at` integer;--> statement-breakpoint
ALTER TABLE `moderation_cases` ADD `hold_released_by_user_id` text REFERENCES users(id);--> statement-breakpoint
ALTER TABLE `violations` ADD `notice_presented_at` integer;--> statement-breakpoint
ALTER TABLE `violations` ADD `appeal_waived_at` integer;--> statement-breakpoint
ALTER TABLE `violations` ADD `severity` text DEFAULT 'standard' NOT NULL;