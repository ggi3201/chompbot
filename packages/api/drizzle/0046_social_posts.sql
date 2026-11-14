-- Posts the user publishes by hand, with what the phone needs to do it.
CREATE TABLE `social_posts` (
  `id` text PRIMARY KEY NOT NULL,
  `title` text NOT NULL,
  `due_at` text NOT NULL,
  `platforms` text NOT NULL,
  `notified_at` text,
  `nudged_at` text,
  `created_at` text NOT NULL
);
