CREATE TABLE `appeals` (
	`id` text PRIMARY KEY NOT NULL,
	`violation_id` text NOT NULL,
	`user_id` text NOT NULL,
	`text` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_by_user_id` text,
	`decided_at` integer,
	`decision_reason` text,
	FOREIGN KEY (`violation_id`) REFERENCES `violations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `appeals_violation_id_unique` ON `appeals` (`violation_id`);--> statement-breakpoint
CREATE INDEX `appeals_status_idx` ON `appeals` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `letter_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`reporter_id` text NOT NULL,
	`reason` text NOT NULL,
	`explanation` text,
	`context` text NOT NULL,
	`hidden` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `moderation_cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `letter_reports_case_reporter_idx` ON `letter_reports` (`case_id`,`reporter_id`);--> statement-breakpoint
CREATE INDEX `letter_reports_reporter_idx` ON `letter_reports` (`reporter_id`);--> statement-breakpoint
CREATE TABLE `moderation_cases` (
	`id` text PRIMARY KEY NOT NULL,
	`bottle_id` text NOT NULL,
	`letter_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`context` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`evidence_text` text NOT NULL,
	`evidence_font` text NOT NULL,
	`evidence_characters` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ai_status` text DEFAULT 'queued' NOT NULL,
	`ai_attempts` integer DEFAULT 0 NOT NULL,
	`ai_next_attempt_at` integer,
	`ai_started_at` integer,
	`ai_verdict` text,
	`ai_reason` text,
	`ai_uncertainty` text,
	`ai_translation` text,
	`ai_language` text,
	`ai_model` text,
	`ai_completed_at` integer,
	`ai_last_error` text,
	`decided_outcome` text,
	`decided_by` text,
	`decided_by_user_id` text,
	`decided_at` integer,
	`decision_reason` text,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`letter_id`) REFERENCES `letters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `moderation_cases_bottle_id_unique` ON `moderation_cases` (`bottle_id`);--> statement-breakpoint
CREATE INDEX `moderation_cases_status_idx` ON `moderation_cases` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `moderation_cases_ai_idx` ON `moderation_cases` (`ai_status`,`ai_next_attempt_at`);--> statement-breakpoint
CREATE INDEX `moderation_cases_sender_idx` ON `moderation_cases` (`sender_id`);--> statement-breakpoint
CREATE TABLE `violations` (
	`id` text PRIMARY KEY NOT NULL,
	`case_id` text NOT NULL,
	`user_id` text NOT NULL,
	`bottle_id` text NOT NULL,
	`category` text NOT NULL,
	`decided_at` integer NOT NULL,
	`decided_by` text NOT NULL,
	`decided_by_user_id` text,
	`reason` text,
	`revoked_at` integer,
	`revoked_by_user_id` text,
	`acknowledged_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `moderation_cases`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `violations_case_id_unique` ON `violations` (`case_id`);--> statement-breakpoint
CREATE INDEX `violations_user_idx` ON `violations` (`user_id`,`decided_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'member' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `role_granted_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `role_granted_by` text;