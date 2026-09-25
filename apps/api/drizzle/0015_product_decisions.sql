ALTER TABLE `moderation_cases` ADD `ai_child_safety` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `moderation_cases` ADD `urgent_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `shore_full_since` integer;--> statement-breakpoint
ALTER TABLE `violations` ADD `appeal_window_starts_at` integer;--> statement-breakpoint
ALTER TABLE `violations` ADD `appeal_reopened_at` integer;