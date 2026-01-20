const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');

class EventService {
	#schemaReady = false;

	constructor(client, db, logger = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
	}

	async ensureSchema() {
		if (this.#schemaReady) return;
		await this.db.query(`CREATE TABLE IF NOT EXISTS events (
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
                        ends_at DATETIME NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch(() => {});

		await this.db.query(`CREATE TABLE IF NOT EXISTS event_participants (
                        event_id BIGINT UNSIGNED NOT NULL,
                        user_id VARCHAR(32) NOT NULL,
                        zone_id BIGINT UNSIGNED NOT NULL,
                        role ENUM('participant','spectator') NOT NULL DEFAULT 'participant',
                        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY(event_id, user_id),
                        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE,
                        FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch(() => {});

		const addColumnIfMissing = async (column, ddl) => {
			const exists = await this.#columnExists('events', column);
			if (!exists) {
				await this.db.query(`ALTER TABLE events ADD COLUMN ${ddl}`).catch(() => {});
			}
		};

		await addColumnIfMissing('guild_id', 'guild_id VARCHAR(32) NULL');
		await addColumnIfMissing('description', 'description TEXT NULL');
		await addColumnIfMissing('created_by', 'created_by VARCHAR(32) NULL');
		await addColumnIfMissing('scheduled_at', 'scheduled_at DATETIME NULL');
		await addColumnIfMissing('message_content', 'message_content TEXT NULL');
		await addColumnIfMissing('embed_title', 'embed_title VARCHAR(256) NULL');
		await addColumnIfMissing('embed_color', 'embed_color VARCHAR(7) NULL');
		await addColumnIfMissing('embed_image', 'embed_image VARCHAR(500) NULL');
		await addColumnIfMissing('game', 'game VARCHAR(120) NULL');
		await addColumnIfMissing('min_participants', 'min_participants INT NULL');
		await addColumnIfMissing('max_participants', 'max_participants INT NULL');
		await addColumnIfMissing('temp_group_id', 'temp_group_id BIGINT UNSIGNED NULL');

		await this.db
			.query("ALTER TABLE events MODIFY COLUMN status ENUM('draft','scheduled','running','ended') NOT NULL DEFAULT 'draft'")
			.catch(() => {});

		const addParticipantColumnIfMissing = async (column, ddl) => {
			const exists = await this.#columnExists('event_participants', column);
			if (!exists) {
				await this.db.query(`ALTER TABLE event_participants ADD COLUMN ${ddl}`).catch(() => {});
			}
		};

		await addParticipantColumnIfMissing('role', "role ENUM('participant','spectator') NOT NULL DEFAULT 'participant'");

		this.#schemaReady = true;
	}

	async handleJoinButton(interaction) {
		await this.ensureSchema().catch(() => {});

		const parsed = this.#extractEventAction(interaction?.customId);
		if (!parsed) {
			await this.#reply(interaction, 'Evenement introuvable.');
			return;
		}

		const role = parsed.action === 'spectate' ? 'spectator' : 'participant';
		const eventId = parsed.eventId;

		const event = await this.#getEvent(eventId);
		if (!event) {
			await this.#reply(interaction, 'Evenement introuvable.');
			return;
		}

		if (event.status !== 'running') {
			await this.#reply(interaction, 'Evenement non actif.');
			return;
		}

		const ended = event.status === 'ended' || (event.ends_at && new Date(event.ends_at) < new Date());
		if (ended) {
			await this.#reply(interaction, 'Evenement termine.');
			return;
		}

		const participantRecord = await this.#getParticipant(eventId, interaction.user.id);
		const alreadyParticipant = participantRecord?.role === 'participant';
		const alreadySpectator = participantRecord?.role === 'spectator';

		const maxParticipants = Number(event.max_participants || 0);
		const hasMax = Number.isFinite(maxParticipants) && maxParticipants > 0;
		if (role === 'participant' && hasMax && !alreadyParticipant) {
			const currentCount = await this.#countParticipants(eventId);
			if (currentCount >= maxParticipants) {
				await this.#reply(interaction, 'Evenement complet.');
				await this.#updateJoinButtonState(interaction, eventId, maxParticipants);
				return;
			}
		}

		if (role === 'participant' && alreadyParticipant) {
			await this.#reply(interaction, 'Deja inscrit.');
			return;
		}

		if (role === 'spectator' && alreadySpectator) {
			await this.#reply(interaction, 'Deja en spectateur.');
			return;
		}

		let zoneId = null;
		if (!participantRecord) {
			zoneId = await this.#resolveZoneId(interaction);
			if (!zoneId) {
				await this.#reply(interaction, 'Impossible de determiner la zone.');
				return;
			}
		}

		await this.#upsertParticipant(eventId, interaction.user.id, zoneId, role);

		const tempGroupService = this.client?.context?.services?.tempGroup;
		if (tempGroupService?.setMemberRole && event.temp_group_id) {
			try {
				await tempGroupService.setMemberRole(event.temp_group_id, interaction.user.id, role, {
					guildId: event.guild_id
				});
			} catch (err) {
				this.#getLogger()?.warn({ err, eventId, userId: interaction.user.id }, 'Failed to update temp group access');
			}
		}

		const replyMessage = role === 'spectator' ? 'Spectateur enregistre.' : 'Inscription enregistree.';
		await this.#reply(interaction, replyMessage);

		if (hasMax) {
			await this.#updateJoinButtonState(interaction, eventId, maxParticipants);
		}
	}

	#extractEventAction(customId) {
		const match = String(customId || '').match(/^event:(join|spectate):(\d+)/);
		if (!match) return null;
		return { action: match[1], eventId: match[2] };
	}

	async #getEvent(eventId) {
		const [rows] = await this.#safeQuery(
			'SELECT id, name, status, ends_at, temp_group_id, guild_id, max_participants FROM events WHERE id = ?',
			[eventId]
		);
		return rows?.[0] || null;
	}

	async #resolveZoneId(interaction) {
		const zoneService = this.client?.context?.services?.zone;
		if (zoneService && interaction?.channel) {
			const context = await zoneService.resolveZoneContextForChannel(interaction.channel).catch(() => null);
			if (context?.zone?.id) return context.zone.id;
		}

		const userId = interaction?.user?.id;
		if (!userId) return null;
		const [rows] = await this.#safeQuery('SELECT zone_id FROM zone_members WHERE user_id = ?', [userId]);
		if (!rows || rows.length !== 1) return null;
		return rows[0].zone_id || null;
	}

	async #getParticipant(eventId, userId) {
		const [rows] = await this.#safeQuery(
			'SELECT role FROM event_participants WHERE event_id = ? AND user_id = ? LIMIT 1',
			[eventId, userId]
		);
		return rows?.[0] || null;
	}

	async #countParticipants(eventId) {
		const [rows] = await this.#safeQuery(
			"SELECT COUNT(*) AS n FROM event_participants WHERE event_id = ? AND role = 'participant'",
			[eventId]
		);
		return Number(rows?.[0]?.n || 0);
	}

	async #upsertParticipant(eventId, userId, zoneId, role) {
		if (!zoneId) {
			const existing = await this.#getParticipant(eventId, userId);
			if (existing) {
				await this.#safeQuery(
					'UPDATE event_participants SET role = ? WHERE event_id = ? AND user_id = ?',
					[role, eventId, userId]
				);
				return;
			}
		}
		await this.#safeQuery(
			`INSERT INTO event_participants (event_id, user_id, zone_id, role)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
			[eventId, userId, zoneId, role]
		);
	}

	async #updateJoinButtonState(interaction, eventId, maxParticipants) {
		if (!interaction?.message?.editable) return;
		const currentCount = await this.#countParticipants(eventId);
		const disableJoin = Number.isFinite(maxParticipants) && currentCount >= maxParticipants;
		const components = this.#buildEventButtons(eventId, { disableJoin });
		await interaction.message.edit({ components }).catch(() => {});
	}

	#buildEventButtons(eventId, { disableJoin = false } = {}) {
		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`event:join:${eventId}`)
				.setLabel('Rejoindre l\'evenement')
				.setStyle(ButtonStyle.Primary)
				.setDisabled(disableJoin),
			new ButtonBuilder()
				.setCustomId(`event:spectate:${eventId}`)
				.setLabel('Spectateur')
				.setStyle(ButtonStyle.Secondary)
		);
		return [row];
	}

	async #safeQuery(sql, params) {
		try {
			return await this.db.query(sql, params);
		} catch (err) {
			if (err?.code === 'ER_NO_SUCH_TABLE' || err?.code === 'ER_BAD_FIELD_ERROR') {
				this.#getLogger()?.warn({ err }, 'Events tables missing');
				return [[], []];
			}
			throw err;
		}
	}

	async #reply(interaction, content) {
		if (!interaction) return;
		const payload = { content, flags: MessageFlags.Ephemeral };
		if (!interaction.deferred && !interaction.replied) {
			await interaction.reply(payload);
		} else {
			await interaction.followUp(payload);
		}
	}

	#getLogger() {
		return this.logger || this.client?.context?.logger || null;
	}

	async #columnExists(table, column) {
		const [rows] = await this.db.query(
			`SELECT COUNT(*) AS n
                         FROM information_schema.COLUMNS
                         WHERE TABLE_SCHEMA = DATABASE()
                           AND TABLE_NAME = ?
                           AND COLUMN_NAME = ?`,
			[table, column]
		);
		return Number(rows?.[0]?.n || 0) > 0;
	}
}

module.exports = { EventService };
