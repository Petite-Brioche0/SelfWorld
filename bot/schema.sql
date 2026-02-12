CREATE TABLE IF NOT EXISTS zones (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
guild_id VARCHAR(32) NOT NULL,
name VARCHAR(100) NOT NULL,
slug VARCHAR(100) NOT NULL,
owner_user_id VARCHAR(32) NOT NULL,
category_id VARCHAR(32) NOT NULL,
text_panel_id VARCHAR(32) NOT NULL,
text_reception_id VARCHAR(32) NOT NULL,
text_general_id VARCHAR(32) NOT NULL,
text_anon_id VARCHAR(32) NOT NULL,
voice_id VARCHAR(32) NOT NULL,
role_owner_id VARCHAR(32) NOT NULL,
role_member_id VARCHAR(32) NOT NULL,
role_muted_id VARCHAR(32) NULL,
policy ENUM('closed','ask','open') NOT NULL DEFAULT 'closed',
ask_join_mode ENUM('request','invite','both') NULL,
ask_approver_mode ENUM('owner','members') NULL,
profile_title VARCHAR(100) NULL,
profile_desc TEXT NULL,
profile_tags JSON NULL,
profile_color VARCHAR(7) NULL,
profile_dynamic TINYINT(1) NOT NULL DEFAULT 0,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
UNIQUE KEY uniq_guild_slug (guild_id, slug)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zone_members (
zone_id BIGINT UNSIGNED NOT NULL,
user_id VARCHAR(32) NOT NULL,
role ENUM('owner','member') NOT NULL DEFAULT 'member',
PRIMARY KEY(zone_id, user_id),
INDEX ix_user (user_id),
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zone_member_roles (
zone_id BIGINT UNSIGNED NOT NULL,
role_id VARCHAR(32) NOT NULL,
user_id VARCHAR(32) NOT NULL,
PRIMARY KEY(zone_id, role_id, user_id),
INDEX ix_user (user_id),
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS join_codes (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
zone_id BIGINT UNSIGNED NOT NULL,
issued_to_user_id VARCHAR(32) NOT NULL,
code VARCHAR(64) NOT NULL,
expires_at DATETIME NOT NULL,
used BOOLEAN NOT NULL DEFAULT FALSE,
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE,
UNIQUE KEY uniq_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS anon_channels (
zone_id BIGINT UNSIGNED NOT NULL,
source_channel_id VARCHAR(32) NOT NULL,
webhook_id VARCHAR(32) NOT NULL,
webhook_token VARCHAR(255) NOT NULL,
PRIMARY KEY(zone_id),
UNIQUE KEY uniq_source_channel (source_channel_id),
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zone_roles (
id INT AUTO_INCREMENT PRIMARY KEY,
zone_id BIGINT UNSIGNED NOT NULL,
role_id VARCHAR(32) NOT NULL,
name VARCHAR(64) NOT NULL,
color VARCHAR(7) NULL,
UNIQUE KEY uq_zone_roleid (zone_id, role_id),
INDEX ix_zone (zone_id),
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS anon_logs (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
guild_id VARCHAR(32) NOT NULL,
source_zone_id BIGINT UNSIGNED NOT NULL,
author_id VARCHAR(32) NOT NULL,
content TEXT NOT NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
INDEX idx_created_at (created_at),
FOREIGN KEY(source_zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS temp_groups (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
name VARCHAR(100) NOT NULL,
category_id VARCHAR(32) NOT NULL,
guild_id VARCHAR(32) NULL,
text_channel_id VARCHAR(32) NULL,
voice_channel_id VARCHAR(32) NULL,
panel_channel_id VARCHAR(32) NULL,
panel_members_message_id VARCHAR(32) NULL,
panel_channels_message_id VARCHAR(32) NULL,
panel_event_message_id VARCHAR(32) NULL,
panel_message_id VARCHAR(32) NULL,
created_by VARCHAR(32) NULL,
event_id BIGINT UNSIGNED NULL,
archived BOOLEAN NOT NULL DEFAULT FALSE,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
expires_at DATETIME NOT NULL,
INDEX ix_event (event_id),
INDEX ix_guild (guild_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS temp_group_members (
temp_group_id BIGINT UNSIGNED NOT NULL,
user_id VARCHAR(32) NOT NULL,
role ENUM('participant','spectator') NOT NULL DEFAULT 'participant',
PRIMARY KEY(temp_group_id, user_id),
FOREIGN KEY(temp_group_id) REFERENCES temp_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS temp_group_channels (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
temp_group_id BIGINT UNSIGNED NOT NULL,
channel_id VARCHAR(32) NOT NULL,
kind ENUM('text','voice') NOT NULL DEFAULT 'text',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
UNIQUE KEY uniq_channel (channel_id),
INDEX ix_group (temp_group_id),
FOREIGN KEY(temp_group_id) REFERENCES temp_groups(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS events (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
name VARCHAR(120) NOT NULL,
guild_id VARCHAR(32) NULL,
description TEXT NULL,
created_by VARCHAR(32) NULL,
message_content TEXT NULL,
embed_title VARCHAR(256) NULL,
embed_color VARCHAR(7) NULL,
embed_image VARCHAR(500) NULL,
game VARCHAR(120) NULL,
min_participants INT NULL,
max_participants INT NULL,
temp_group_id BIGINT UNSIGNED NULL,
status ENUM('draft','scheduled','running','ended') NOT NULL DEFAULT 'draft',
scheduled_at DATETIME NULL,
starts_at DATETIME NULL,
ends_at DATETIME NULL,
INDEX ix_temp_group (temp_group_id),
INDEX ix_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_participants (
event_id BIGINT UNSIGNED NOT NULL,
user_id VARCHAR(32) NOT NULL,
zone_id BIGINT UNSIGNED NOT NULL,
role ENUM('participant','spectator') NOT NULL DEFAULT 'participant',
joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
PRIMARY KEY(event_id, user_id),
FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS event_messages (
event_id BIGINT UNSIGNED NOT NULL,
channel_id VARCHAR(32) NOT NULL,
message_id VARCHAR(32) NOT NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
PRIMARY KEY(event_id, channel_id),
UNIQUE KEY uniq_message (message_id),
INDEX ix_event (event_id),
FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hub_channels (
guild_id VARCHAR(32) NOT NULL,
user_id VARCHAR(32) NOT NULL,
channel_id VARCHAR(32) NOT NULL,
join_message_id VARCHAR(32) NULL,
request_message_id VARCHAR(32) NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
PRIMARY KEY (guild_id, user_id),
UNIQUE KEY uniq_channel (channel_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hub_requests (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
guild_id VARCHAR(32) NOT NULL,
user_id VARCHAR(32) NOT NULL,
kind ENUM('announcement','event') NOT NULL,
status ENUM('draft','pending','accepted','denied') NOT NULL DEFAULT 'draft',
content TEXT NULL,
embed_title VARCHAR(256) NULL,
embed_description TEXT NULL,
embed_color VARCHAR(7) NULL,
embed_image VARCHAR(500) NULL,
message_content TEXT NULL,
game VARCHAR(120) NULL,
min_participants INT NULL,
max_participants INT NULL,
scheduled_at DATETIME NULL,
preview_channel_id VARCHAR(32) NULL,
preview_message_id VARCHAR(32) NULL,
review_channel_id VARCHAR(32) NULL,
review_message_id VARCHAR(32) NULL,
decided_by VARCHAR(32) NULL,
decided_at DATETIME NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
updated_at TIMESTAMP NULL,
INDEX ix_guild_user (guild_id, user_id),
INDEX ix_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_announcements (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
guild_id VARCHAR(32) NOT NULL,
author_id VARCHAR(32) NOT NULL,
content TEXT NULL,
embed_title VARCHAR(256) NULL,
embed_description TEXT NULL,
embed_color VARCHAR(7) NULL,
embed_image VARCHAR(500) NULL,
scheduled_at DATETIME NULL,
status ENUM('draft','scheduled','sent','failed') NOT NULL DEFAULT 'draft',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
sent_at DATETIME NULL,
INDEX ix_guild (guild_id),
INDEX ix_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zone_activity (
zone_id BIGINT UNSIGNED NOT NULL,
day DATE NOT NULL,
msgs INT NOT NULL DEFAULT 0,
reacts INT NOT NULL DEFAULT 0,
voice_minutes INT NOT NULL DEFAULT 0,
event_points INT NOT NULL DEFAULT 0,
PRIMARY KEY(zone_id, day),
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS settings (
guild_id VARCHAR(32) PRIMARY KEY,
anon_admin_channel_id VARCHAR(32) NULL,
requests_channel_id VARCHAR(32) NULL,
events_admin_channel_id VARCHAR(32) NULL,
events_admin_message_id VARCHAR(32) NULL,
journal_channel_id VARCHAR(32) NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS panel_messages (
zone_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
refresh_msg_id VARCHAR(32) NULL,
members_msg_id VARCHAR(32) NULL,
roles_msg_id VARCHAR(32) NULL,
channels_msg_id VARCHAR(32) NULL,
policy_msg_id VARCHAR(32) NULL,
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
code_anchor_channel_id VARCHAR(32) NULL,
code_anchor_message_id VARCHAR(32) NULL,
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS panel_message_registry (
zone_id BIGINT UNSIGNED NOT NULL,
kind VARCHAR(32) NOT NULL,
message_id VARCHAR(32) NOT NULL,
PRIMARY KEY(zone_id, kind),
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zone_invite_codes (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
zone_id BIGINT UNSIGNED NOT NULL,
code VARCHAR(16) NOT NULL UNIQUE,
created_by VARCHAR(32) NOT NULL,
expires_at DATETIME NULL,
max_uses INT NULL,
uses INT NOT NULL DEFAULT 0,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
INDEX ix_zone (zone_id),
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zone_join_requests (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
zone_id BIGINT UNSIGNED NOT NULL,
user_id VARCHAR(32) NOT NULL,
status ENUM('pending','accepted','declined','expired') NOT NULL DEFAULT 'pending',
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
decided_by VARCHAR(32) NULL,
decided_at DATETIME NULL,
note TEXT NULL,
message_channel_id VARCHAR(32) NULL,
message_id VARCHAR(32) NULL,
INDEX ix_zone_user (zone_id, user_id),
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS zone_creation_requests (
id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
guild_id VARCHAR(32) NOT NULL,
user_id VARCHAR(32) NOT NULL,
owner_user_id VARCHAR(32) NOT NULL,
name VARCHAR(100) NOT NULL,
description TEXT NULL,
extras TEXT NULL,
policy ENUM('open','ask','closed') NOT NULL DEFAULT 'ask',
status ENUM('pending','accepted','denied') NOT NULL DEFAULT 'pending',
validation_errors TEXT NULL,
message_channel_id VARCHAR(32) NULL,
message_id VARCHAR(32) NULL,
zone_id BIGINT UNSIGNED NULL,
created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
decided_at DATETIME NULL,
decided_by VARCHAR(32) NULL,
updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
INDEX ix_guild (guild_id),
INDEX ix_status (status),
INDEX ix_user (user_id),
FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
