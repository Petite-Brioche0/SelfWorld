const {
	ActionRowBuilder,
	ButtonBuilder
} = require('discord.js');
const { sanitizeName } = require('../utils/validation');
const { columnExists } = require('../utils/serviceHelpers');

// Domain modules (mixed into prototype below)
const creation = require('./policy/creation');
const config = require('./policy/config');
const joinRequests = require('./policy/joinRequests');
const inviteCodes = require('./policy/inviteCodes');

class PolicyService {
	#schemaReady = false;

	constructor(client, db, logger = null, panelService = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
		this.panelService = panelService;
		this.services = null;
	}

	/** @param {object} panelService - PanelService instance */
	setPanelService(panelService) {
		this.panelService = panelService;
		if (this.panelService?.setServices && this.services) {
			this.panelService.setServices(this.services);
		}
	}

	/** @param {object} services - Service registry injected after construction */
	setServices(services) {
		this.services = services;
		if (this.panelService?.setServices) {
			this.panelService.setServices(services);
		}
	}

	// --- Public accessor ---

	/**
	 * Fetches a zone record by ID after ensuring schema is ready.
	 * @param {number} zoneId
	 * @returns {Promise<object|null>}
	 */
	async getZone(zoneId) {
		await this.ensureSchema();
		return this._getZone(zoneId);
	}

	// --- Shared infrastructure (used by domain modules via this._xxx) ---

	/** Creates all policy-related tables if they don't exist. Idempotent. */
	async ensureSchema() {
		if (this.#schemaReady) return;

		await this.db.query(`CREATE TABLE IF NOT EXISTS zone_invite_codes (
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
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);

		await this.db.query(`CREATE TABLE IF NOT EXISTS zone_join_requests (
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
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);

		await this.db.query(`CREATE TABLE IF NOT EXISTS zone_creation_requests (
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
			FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE SET NULL
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);

		const addColumnIfMissing = async (table, column, ddl) => {
			const exists = await columnExists(this.db, table, column);
			if (!exists) {
				await this.db.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
			}
		};

		await addColumnIfMissing(
			'zones',
			'policy',
			"policy ENUM('open','ask','closed') NOT NULL DEFAULT 'closed'"
		);
		await addColumnIfMissing(
			'zones',
			'ask_join_mode',
			"ask_join_mode ENUM('request','invite','both') NULL"
		);
		await addColumnIfMissing(
			'zones',
			'ask_approver_mode',
			"ask_approver_mode ENUM('owner','members') NULL"
		);
		await addColumnIfMissing('zones', 'profile_title', 'profile_title VARCHAR(100) NULL');
		await addColumnIfMissing('zones', 'profile_desc', 'profile_desc TEXT NULL');
		await addColumnIfMissing('zones', 'profile_tags', 'profile_tags JSON NULL');
		await addColumnIfMissing('zones', 'profile_color', 'profile_color VARCHAR(7) NULL');
		await addColumnIfMissing(
			'zones',
			'profile_dynamic',
			'profile_dynamic TINYINT(1) NOT NULL DEFAULT 0'
		);

		await this.db
			.query(
				"UPDATE zones SET policy='ask', ask_join_mode = COALESCE(ask_join_mode, 'invite') WHERE policy = 'invite'"
			)
			.catch((err) => {
				this.logger?.warn({ err }, 'Failed to migrate invite policy to ask');
			});

		await this.db
			.query(
				"ALTER TABLE zones MODIFY COLUMN policy ENUM('open','ask','closed') NOT NULL DEFAULT 'closed'"
			)
			.catch((err) => {
				this.logger?.warn({ err }, 'Failed to modify policy enum column');
			});

		await addColumnIfMissing('zone_join_requests', 'note', 'note TEXT NULL');
		await addColumnIfMissing(
			'zone_join_requests',
			'message_channel_id',
			'message_channel_id VARCHAR(32) NULL'
		);
		await addColumnIfMissing('zone_join_requests', 'message_id', 'message_id VARCHAR(32) NULL');

		await addColumnIfMissing(
			'panel_messages',
			'code_anchor_channel_id',
			'code_anchor_channel_id VARCHAR(32) NULL'
		);
		await addColumnIfMissing(
			'panel_messages',
			'code_anchor_message_id',
			'code_anchor_message_id VARCHAR(32) NULL'
		);

		await addColumnIfMissing(
			'zone_creation_requests',
			'owner_user_id',
			"owner_user_id VARCHAR(32) NOT NULL DEFAULT ''"
		);
		await addColumnIfMissing('zone_creation_requests', 'extras', 'extras TEXT NULL');
		await addColumnIfMissing('zone_creation_requests', 'validation_errors', 'validation_errors TEXT NULL');
		await addColumnIfMissing('zone_creation_requests', 'message_channel_id', 'message_channel_id VARCHAR(32) NULL');
		await addColumnIfMissing('zone_creation_requests', 'message_id', 'message_id VARCHAR(32) NULL');
		await addColumnIfMissing('zone_creation_requests', 'zone_id', 'zone_id BIGINT UNSIGNED NULL');

		this.#schemaReady = true;
	}

	async _getZone(zoneId) {
		const [rows] = await this.db.query('SELECT * FROM zones WHERE id = ?', [zoneId]);
		if (!rows?.length) return null;
		return this._hydrateZoneRow(rows[0]);
	}

	_hydrateZoneRow(row) {
		if (!row) return null;
		const zone = { ...row };
		if (zone.profile_tags) {
			if (Array.isArray(zone.profile_tags)) {
				// already an array
			} else if (typeof zone.profile_tags === 'string') {
				try {
					zone.profile_tags = JSON.parse(zone.profile_tags);
				} catch {
					zone.profile_tags = null;
				}
			}
		}
		return zone;
	}

	_slugify(value) {
		return sanitizeName(value)
			.toLowerCase()
			.replace(/[^a-z0-9\-\s]/g, '')
			.replace(/\s+/g, '-')
			.slice(0, 32);
	}

	async _zoneNameExists(guildId, name) {
		if (!guildId || !name) return false;
		const slug = this._slugify(name);
		const [rows] = await this.db.query('SELECT id FROM zones WHERE guild_id = ? AND slug = ? LIMIT 1', [guildId, slug]);
		return Boolean(rows?.length);
	}

	async _isZoneOwner(zone, userId) {
		if (!zone) return false;
		if (String(zone.owner_user_id) === String(userId)) return true;
		if (!zone.id) return false;
		const [rows] = await this.db.query(
			'SELECT role FROM zone_members WHERE zone_id = ? AND user_id = ? LIMIT 1',
			[zone.id, userId]
		);
		return rows?.[0]?.role === 'owner';
	}

	async _refreshPanel(zoneId) {
		if (!this.panelService?.refresh) return;
		try {
			await this.panelService.refresh(zoneId, ['policy']);
		} catch (err) {
			this.logger?.warn({ err, zoneId }, 'Failed to refresh policy panel');
		}
	}

	async _dmUser(userId, payload) {
		if (!payload || !userId) return;
		try {
			const user = await this.client.users.fetch(userId);
			await user.send(payload).catch((err) => {
				if (err?.code === 50007) return;
				this.logger?.debug({ err, userId }, 'Failed to DM user');
			});
		} catch (err) {
			this.logger?.debug({ err, userId }, 'Failed to fetch user for DM');
		}
	}

	async _grantZoneMembership(zone, userId) {
		if (!zone?.id) return;
		let added = false;

		if (this.services?.zone?.addMember) {
			try {
				await this.services.zone.addMember(zone.id, userId);
				added = true;
			} catch (err) {
				this.logger?.warn({ err, zoneId: zone.id, userId }, 'ZoneService addMember failed, falling back');
			}
		}

		if (!added) {
			try {
				const guild = await this.client.guilds.fetch(zone.guild_id);
				const member = await guild.members.fetch(userId).catch(() => null);
				const roleMember = zone.role_member_id
					? await guild.roles.fetch(zone.role_member_id).catch(() => null)
					: null;
				if (member && roleMember) {
					await member.roles.add(roleMember).catch((err) => {
						this.logger?.warn({ err, userId, roleId: roleMember.id, zoneId: zone.id }, 'Failed to add member role');
					});
				}
				await this.db.query(
					'INSERT INTO zone_members (zone_id, user_id, role) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE role = new.role',
					[zone.id, userId, 'member']
				);
				added = true;
			} catch (err) {
				this.logger?.warn({ err, zoneId: zone.id, userId }, 'Failed to grant membership fallback');
			}
		}

		if (added) {
			const welcomeService = this.client?.context?.services?.welcome;
			if (welcomeService?.closeOnboardingChannelForUser) {
				welcomeService
					.closeOnboardingChannelForUser(zone.guild_id, userId)
					.catch((err) => {
						this.logger?.warn({ err, zoneId: zone.id, userId }, 'Failed to cleanup onboarding channel');
					});
			}
		}
	}

	async _canModerateRequests(zone, userId, member = null) {
		if (await this._isZoneOwner(zone, userId)) return true;
		const approver = zone.ask_approver_mode || 'owner';
		if (approver === 'members') {
			if (member) {
				return member.roles?.cache?.has(zone.role_member_id) || false;
			}
			try {
				const guild = await this.client.guilds.fetch(zone.guild_id);
				const fetchedMember = await guild.members.fetch(userId).catch(() => null);
				return fetchedMember?.roles?.cache?.has(zone.role_member_id) || false;
			} catch (err) {
				this.logger?.debug({ err, userId, zoneId: zone.id }, 'Failed to fetch member for moderation check');
				return false;
			}
		}
		return false;
	}

	async _disableInteractionRow(message) {
		if (!message?.components?.length) return;
		try {
			const rows = message.components.map((row) => {
				const newRow = new ActionRowBuilder();
				for (const component of row.components) {
					if (component.data?.type === 2 || component.style) {
						newRow.addComponents(ButtonBuilder.from(component).setDisabled(true));
					}
				}
				return newRow;
			});
			await message.edit({ components: rows }).catch((err) => {
				if (err?.code === 10008) return;
				this.logger?.warn({ err, messageId: message?.id }, 'Failed to disable interaction row');
			});
		} catch (err) {
			this.logger?.debug({ err }, 'Failed to build disabled interaction rows');
		}
	}

	async _ensurePanelRecord(zoneId) {
		const [rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id = ?', [zoneId]);
		if (rows?.length) return rows[0];
		await this.db.query(
			'INSERT INTO panel_messages (zone_id) VALUES (?) ON DUPLICATE KEY UPDATE zone_id = zone_id',
			[zoneId]
		).catch((err) => {
			this.logger?.warn({ err, zoneId }, 'Failed to insert panel_messages record');
		});
		const [fresh] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id = ?', [zoneId]);
		return fresh?.[0] || null;
	}
}

// Mix in domain methods
Object.assign(PolicyService.prototype, creation, config, joinRequests, inviteCodes);

module.exports = { PolicyService };
