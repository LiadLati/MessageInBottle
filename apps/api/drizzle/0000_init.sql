CREATE TABLE `blocks` (
	`blocker_id` text NOT NULL,
	`blocked_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`blocker_id`, `blocked_id`),
	FOREIGN KEY (`blocker_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`blocked_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `bottles` (
	`id` text PRIMARY KEY NOT NULL,
	`sender_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`letter_id` text NOT NULL,
	`sender_name_snapshot` text NOT NULL,
	`recipient_name_snapshot` text NOT NULL,
	`origin_shore_id` text NOT NULL,
	`origin_shore_name` text NOT NULL,
	`destination_shore_id` text NOT NULL,
	`destination_shore_name` text NOT NULL,
	`state` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`moderation_status` text DEFAULT 'clear' NOT NULL,
	`released_at` integer NOT NULL,
	`delivered_at` integer,
	`opened_at` integer,
	`completed_at` integer,
	`loss_reason` text,
	`aging_profile` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`letter_id`) REFERENCES `letters`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`origin_shore_id`) REFERENCES `shores`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`destination_shore_id`) REFERENCES `shores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `bottles_sender_idx` ON `bottles` (`sender_id`);--> statement-breakpoint
CREATE INDEX `bottles_recipient_state_idx` ON `bottles` (`recipient_id`,`state`);--> statement-breakpoint
CREATE INDEX `bottles_state_idx` ON `bottles` (`state`);--> statement-breakpoint
CREATE TABLE `capacity_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`bottle_id` text NOT NULL,
	`shore_id` text NOT NULL,
	`status` text NOT NULL,
	`reserved_at` integer NOT NULL,
	`released_at` integer,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shore_id`) REFERENCES `shores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `capacity_reservations_bottle_id_unique` ON `capacity_reservations` (`bottle_id`);--> statement-breakpoint
CREATE INDEX `capacity_reservations_shore_status_idx` ON `capacity_reservations` (`shore_id`,`status`);--> statement-breakpoint
CREATE TABLE `dev_clock` (
	`id` integer PRIMARY KEY NOT NULL,
	`offset_ms` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `friendships` (
	`id` text PRIMARY KEY NOT NULL,
	`user_low_id` text NOT NULL,
	`user_high_id` text NOT NULL,
	`requested_by_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`accepted_at` integer,
	FOREIGN KEY (`user_low_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_high_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requested_by_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `friendships_pair_idx` ON `friendships` (`user_low_id`,`user_high_id`);--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
	`user_id` text NOT NULL,
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_status` integer NOT NULL,
	`response_body` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `scope`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `journey_events` (
	`id` text PRIMARY KEY NOT NULL,
	`bottle_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journey_events_bottle_seq_idx` ON `journey_events` (`bottle_id`,`seq`);--> statement-breakpoint
CREATE TABLE `letters` (
	`id` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`characters` integer NOT NULL,
	`original_font` text NOT NULL,
	`disclosure_version` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`bottle_id` text,
	`dedupe_key` text NOT NULL,
	`message` text NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe_key_unique` ON `notifications` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `route_edges` (
	`graph_version` integer NOT NULL,
	`from_node_id` text NOT NULL,
	`to_node_id` text NOT NULL,
	`length` integer NOT NULL,
	PRIMARY KEY(`graph_version`, `from_node_id`, `to_node_id`),
	FOREIGN KEY (`graph_version`) REFERENCES `route_graph_versions`(`version`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `route_graph_versions` (
	`version` integer PRIMARY KEY NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `route_nodes` (
	`id` text NOT NULL,
	`graph_version` integer NOT NULL,
	`kind` text NOT NULL,
	`shore_id` text,
	`chart_x` integer NOT NULL,
	`chart_y` integer NOT NULL,
	PRIMARY KEY(`graph_version`, `id`),
	FOREIGN KEY (`graph_version`) REFERENCES `route_graph_versions`(`version`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shore_id`) REFERENCES `shores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `route_plans` (
	`id` text PRIMARY KEY NOT NULL,
	`bottle_id` text NOT NULL,
	`plan_version` integer NOT NULL,
	`graph_version` integer NOT NULL,
	`node_ids` text NOT NULL,
	`total_length` integer NOT NULL,
	`planned_duration_ms` integer NOT NULL,
	`starts_at` integer NOT NULL,
	`start_progress` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`bottle_id`) REFERENCES `bottles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `route_plans_bottle_version_idx` ON `route_plans` (`bottle_id`,`plan_version`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `shores` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`chart_x` integer NOT NULL,
	`chart_y` integer NOT NULL,
	`capacity` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`shore_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`shore_id`) REFERENCES `shores`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);