const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
	StringSelectMenuBuilder,
	TextInputBuilder,
	TextInputStyle
} = require('discord.js');

class TempGroupService {
	#schemaReady = false;

	constructor(client, db, logger = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
	}

	async ensureSchema() {
		if (this.#schemaReady) return;
		await this.db.query(`CREATE TABLE IF NOT EXISTS temp_groups (
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
                        expires_at DATETIME NOT NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch((_err) => {
			// Expected failure if table already exists - intentionally silent
		});

		await this.db.query(`CREATE TABLE IF NOT EXISTS temp_group_members (
                        temp_group_id BIGINT UNSIGNED NOT NULL,
                        user_id VARCHAR(32) NOT NULL,
                        role ENUM('participant','spectator') NOT NULL DEFAULT 'participant',
                        PRIMARY KEY(temp_group_id, user_id),
                        FOREIGN KEY(temp_group_id) REFERENCES temp_groups(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch((_err) => {
			// Expected failure if table already exists - intentionally silent
		});

		await this.db.query(`CREATE TABLE IF NOT EXISTS temp_group_channels (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        temp_group_id BIGINT UNSIGNED NOT NULL,
                        channel_id VARCHAR(32) NOT NULL,
                        kind ENUM('text','voice') NOT NULL DEFAULT 'text',
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        UNIQUE KEY uniq_channel (channel_id),
                        INDEX ix_group (temp_group_id),
                        FOREIGN KEY(temp_group_id) REFERENCES temp_groups(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch((_err) => {
			// Expected failure if table already exists - intentionally silent
		});

		const addColumnIfMissing = async (column, ddl) => {
			const exists = await this.#columnExists('temp_groups', column);
			if (!exists) {
				await this.db.query(`ALTER TABLE temp_groups ADD COLUMN ${ddl}`).catch((_err) => {
					// Expected failure if column already exists - intentionally silent
				});
			}
		};

		await addColumnIfMissing('guild_id', 'guild_id VARCHAR(32) NULL');
		await addColumnIfMissing('text_channel_id', 'text_channel_id VARCHAR(32) NULL');
		await addColumnIfMissing('voice_channel_id', 'voice_channel_id VARCHAR(32) NULL');
		await addColumnIfMissing('panel_channel_id', 'panel_channel_id VARCHAR(32) NULL');
		await addColumnIfMissing('panel_members_message_id', 'panel_members_message_id VARCHAR(32) NULL');
		await addColumnIfMissing('panel_channels_message_id', 'panel_channels_message_id VARCHAR(32) NULL');
		await addColumnIfMissing('panel_event_message_id', 'panel_event_message_id VARCHAR(32) NULL');
		await addColumnIfMissing('panel_message_id', 'panel_message_id VARCHAR(32) NULL');
		await addColumnIfMissing('created_by', 'created_by VARCHAR(32) NULL');
		await addColumnIfMissing('event_id', 'event_id BIGINT UNSIGNED NULL');

		const addMemberColumnIfMissing = async (column, ddl) => {
			const exists = await this.#columnExists('temp_group_members', column);
			if (!exists) {
				await this.db.query(`ALTER TABLE temp_group_members ADD COLUMN ${ddl}`).catch((_err) => {
					// Expected failure if column already exists - intentionally silent
				});
			}
		};

		await addMemberColumnIfMissing('role', "role ENUM('participant','spectator') NOT NULL DEFAULT 'participant'");

		this.#schemaReady = true;
	}

	async createGroup({ guildId, name, expiresAt, createdBy = null, eventId = null }) {
		await this.ensureSchema();
		const guild = await this.client.guilds.fetch(guildId).catch(() => null);
		if (!guild) throw new Error('Guilde introuvable');

		const slug = this.#slugify(name);
		const baseName = slug ? `event-${slug}` : `event-${Date.now()}`;

		const overwrites = await this.#buildBaseOverwrites(guild, createdBy);
		const category = await guild.channels.create({
			name: baseName,
			type: ChannelType.GuildCategory,
			permissionOverwrites: overwrites,
			reason: 'Event temp group'
		});

		const textChannel = await guild.channels.create({
			name: `${baseName}-chat`,
			type: ChannelType.GuildText,
			parent: category.id,
			permissionOverwrites: overwrites,
			reason: 'Event temp group'
		});

		const panelChannel = await guild.channels.create({
			name: `${baseName}-panel`,
			type: ChannelType.GuildText,
			parent: category.id,
			permissionOverwrites: overwrites,
			reason: 'Event temp group'
		});

		const voiceChannel = await guild.channels.create({
			name: `${baseName}-vocal`,
			type: ChannelType.GuildVoice,
			parent: category.id,
			permissionOverwrites: overwrites,
			reason: 'Event temp group'
		});

		const expiry = this.#normalizeExpiry(expiresAt);
		const [res] = await this.db.query(
			`INSERT INTO temp_groups
                         (name, category_id, text_channel_id, voice_channel_id, panel_channel_id, archived, created_at, expires_at, guild_id, created_by, event_id)
                         VALUES (?, ?, ?, ?, ?, 0, NOW(), ?, ?, ?, ?)`,
			[
				name,
				category.id,
				textChannel.id,
				voiceChannel.id,
				panelChannel.id,
				expiry,
				guildId,
				createdBy,
				eventId
			]
		);

		const group = {
			id: res.insertId,
			name,
			category_id: category.id,
			text_channel_id: textChannel.id,
			voice_channel_id: voiceChannel.id,
			panel_channel_id: panelChannel.id,
			archived: 0,
			expires_at: expiry,
			guild_id: guildId,
			created_by: createdBy,
			event_id: eventId
		};

		await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to render temp group panel');
		});

		return group;
	}

	async getGroup(groupId) {
		await this.ensureSchema();
		return this.#getGroup(groupId);
	}

	async updateExpiry(groupId, expiresAt) {
		await this.ensureSchema();
		const expiry = this.#normalizeExpiry(expiresAt);
		await this.#safeQuery('UPDATE temp_groups SET expires_at = ?, archived = 0 WHERE id = ?', [
			expiry,
			groupId
		]);
		const group = await this.#getGroup(groupId);
		if (group) {
			await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
		}
		return group;
	}

	async addMember(groupId, userId, { guildId = null, role = 'participant' } = {}) {
		return this.setMemberRole(groupId, userId, role, { guildId });
	}

	async setMemberRole(groupId, userId, role, { guildId = null, allowPanel = false } = {}) {
		await this.ensureSchema();
		const group = await this.#getGroup(groupId);
		if (!group) throw new Error('Groupe temporaire introuvable');
		if (group.archived) throw new Error('Groupe temporaire archivé');

		const normalizedRole = this.#normalizeMemberRole(role) || 'participant';

		const resolvedGuildId = group.guild_id || guildId;
		const guild = await this.client.guilds.fetch(resolvedGuildId).catch(() => null);
		if (!guild) throw new Error('Guilde introuvable');

		const member = await guild.members.fetch(userId).catch(() => null);
		if (!member) throw new Error('Membre introuvable');

		await this.#applyMemberPermissions(group, member, normalizedRole, { allowPanel });

		await this.#safeQuery(
			`INSERT INTO temp_group_members (temp_group_id, user_id, role)
                         VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
			[groupId, member.id, normalizedRole]
		);

		await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
		return { group, role: normalizedRole };
	}

	async setGroupOwner(groupId, userId) {
		if (!groupId || !userId) return;
		await this.ensureSchema();
		await this.#safeQuery('UPDATE temp_groups SET created_by = ? WHERE id = ?', [userId, groupId]);
	}

	async grantPanelAccess(groupId, userId, { guildId = null } = {}) {
		await this.ensureSchema();
		const group = await this.#getGroup(groupId);
		if (!group) throw new Error('Groupe temporaire introuvable');

		const resolvedGuildId = group.guild_id || guildId;
		const guild = resolvedGuildId ? await this.client.guilds.fetch(resolvedGuildId).catch(() => null) : null;
		if (!guild) throw new Error('Guilde introuvable');

		const member = await guild.members.fetch(userId).catch(() => null);
		if (!member) throw new Error('Membre introuvable');

		const panelChannel = await this.#fetchChannel(group.panel_channel_id);
		if (panelChannel) {
			await panelChannel.permissionOverwrites
				.edit(member.id, { ViewChannel: true, ReadMessageHistory: true })
				.catch((err) => {
					this.#getLogger()?.error({ err, channelId: panelChannel.id, userId: member.id, groupId }, 'Failed to update permissions');
				});
		}
	}

	async removeMember(groupId, userId, { guildId = null } = {}) {
		await this.ensureSchema();
		const group = await this.#getGroup(groupId);
		if (!group) throw new Error('Groupe temporaire introuvable');

		const resolvedGuildId = group.guild_id || guildId;
		const guild = resolvedGuildId ? await this.client.guilds.fetch(resolvedGuildId).catch(() => null) : null;
		if (guild) {
			const member = await guild.members.fetch(userId).catch(() => null);
			if (member) {
				await this.#clearMemberPermissions(group, member.id);
			}
		}

		await this.#safeQuery('DELETE FROM temp_group_members WHERE temp_group_id = ? AND user_id = ?', [
			groupId,
			userId
		]);
		await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
	}

	async handleButton(interaction) {
		await this.ensureSchema();
		const customId = interaction?.customId || '';
		if (!customId.startsWith('temp:')) {
			await this.#reply(interaction, 'Action inconnue.');
			return;
		}

		const usesModal = /^temp:(channel:create|channel:rename|event:edit):/.test(customId);
		if (!usesModal) {
			await this.#deferReply(interaction);
		}

		let match = customId.match(/^temp:member:remove:(\d+):(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const userId = match[2];
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			if (group.event_id) {
				await this.client?.context?.services?.event?.ensureSchema?.().catch((err) => {
					this.#getLogger()?.warn({ err }, 'Failed to ensure event schema');
				});
				await this.#removeEventParticipant(group.event_id, userId);
			}
			await this.removeMember(group.id, userId, { guildId: group.guild_id });
			await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
			await this.#reply(interaction, 'Membre retire.');
			return;
		}

		match = customId.match(/^temp:member:switch:(\d+):(\d+):(participant|spectator)$/);
		if (match) {
			const groupId = Number(match[1]);
			const userId = match[2];
			const targetRole = match[3];
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}

			const currentRole = await this.#getMemberRole(group.id, userId);
			if (currentRole === targetRole) {
				await this.#reply(interaction, 'Membre deja dans ce role.');
				return;
			}

			if (group.event_id) {
				await this.client?.context?.services?.event?.ensureSchema?.().catch((err) => {
					this.#getLogger()?.warn({ err }, 'Failed to ensure event schema');
				});
				const eventMeta = await this.#getEventMeta(group.event_id);
				const maxParticipants = Number(eventMeta?.max_participants || 0);
				const hasMax = Number.isFinite(maxParticipants) && maxParticipants > 0;
				const existingRole = await this.#getEventParticipantRole(group.event_id, userId);

				if (targetRole === 'participant' && hasMax && existingRole !== 'participant') {
					const count = await this.#countEventParticipants(group.event_id);
					if (count >= maxParticipants) {
						await this.#reply(interaction, 'Nombre maximal de participants atteint.');
						return;
					}
				}

				const eventUpdate = await this.#setEventParticipantRole(group.event_id, userId, targetRole);
				if (!eventUpdate.ok) {
					await this.#reply(interaction, eventUpdate.message || 'Impossible de mettre a jour l\'evenement.');
					return;
				}
			}

			await this.setMemberRole(group.id, userId, targetRole, { guildId: group.guild_id });
			await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
			await this.#reply(interaction, 'Membre mis a jour.');
			return;
		}

		match = customId.match(/^temp:channel:create:(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			const modal = this.#buildChannelCreateModal(group);
			await interaction.showModal(modal);
			return;
		}

		match = customId.match(/^temp:channel:rename:(\d+):(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const channelId = match[2];
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			const allowed = await this.#isExtraChannel(group.id, channelId);
			if (!allowed) {
				await this.#reply(interaction, 'Salon non modifiable.');
				return;
			}
			const modal = await this.#buildChannelRenameModal(group, channelId);
			await interaction.showModal(modal);
			return;
		}

		match = customId.match(/^temp:channel:delete:(\d+):(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const channelId = match[2];
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			const allowed = await this.#isExtraChannel(group.id, channelId);
			if (!allowed) {
				await this.#reply(interaction, 'Salon non modifiable.');
				return;
			}
			await this.#deleteExtraChannel(group, channelId);
			await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
			await this.#reply(interaction, 'Salon supprime.');
			return;
		}

		match = customId.match(/^temp:event:edit:(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			if (!group.event_id) {
				await this.#reply(interaction, 'Evenement introuvable.');
				return;
			}
			const event = await this.#getEventDetails(group.event_id);
			if (!event) {
				await this.#reply(interaction, 'Evenement introuvable.');
				return;
			}
			const modal = this.#buildEventEditModal(group, event);
			await interaction.showModal(modal);
			return;
		}

		match = customId.match(/^temp:event:refresh:(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			if (group.event_id) {
				await this.client?.context?.services?.staffPanel?.refreshEventMessages?.(group.event_id).catch((err) => {
					this.#getLogger()?.warn({ err, eventId: group.event_id }, 'Failed to refresh event messages');
				});
			}
			await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
			await this.#reply(interaction, 'Panneau actualise.');
			return;
		}

		const parsed = this.#parseButton(customId);
		if (!parsed) {
			await this.#reply(interaction, 'Action inconnue.');
			return;
		}

		const group = await this.#getGroup(parsed.groupId);
		if (!group) {
			await this.#reply(interaction, 'Groupe temporaire introuvable.');
			return;
		}
		if (!this.#canManageGroup(interaction, group)) {
			await this.#reply(interaction, 'Action réservée au staff.');
			return;
		}

		if (parsed.action === 'extend') {
			let baseExpiry = group.expires_at;
			if (group.event_id) {
				const event = await this.#getEventDetails(group.event_id);
				if (event?.ends_at) baseExpiry = event.ends_at;
			}
			const newExpiry = this.#computeExtension(baseExpiry);
			await this.#safeQuery('UPDATE temp_groups SET expires_at = ?, archived = 0 WHERE id = ?', [
				newExpiry,
				parsed.groupId
			]);
			if (group.event_id) {
				await this.#safeQuery('UPDATE events SET ends_at = ? WHERE id = ?', [newExpiry, group.event_id]);
				await this.client?.context?.services?.staffPanel?.refreshEventMessages?.(group.event_id).catch((err) => {
					this.#getLogger()?.warn({ err, eventId: group.event_id }, 'Failed to refresh event messages');
				});
			}
			await this.ensurePanel({ ...group, expires_at: newExpiry }).catch((err) => {
				this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
			});
			await this.#reply(interaction, 'Expiration prolongee.');
			return;
		}

		if (parsed.action === 'delete') {
			await this.archiveGroup(group);
			await this.#reply(interaction, 'Groupe archive.');
		}
	}

	async handleSelectMenu(interaction) {
		await this.ensureSchema();
		const customId = interaction?.customId || '';
		if (!customId.startsWith('temp:')) return;

		let match = customId.match(/^temp:member:select:(\d+):(participant|spectator)$/);
		if (match) {
			const groupId = Number(match[1]);
			const role = match[2];
			const userId = interaction.values?.[0];
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			if (!userId || userId === 'noop') {
				await interaction.deferUpdate().catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.#getLogger()?.warn({ err, userId: interaction.user.id }, 'Failed to defer interaction');
				});
				return;
			}
			const counts = await this.#getMemberCounts(group.id);
			const panel = await this.#renderMembersPanel(group, counts, { role, userId });
			await interaction.update({ embeds: [panel.embed], components: panel.components }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.#getLogger()?.warn({ err, userId: interaction.user.id, groupId: group.id }, 'Failed to send interaction reply');
			});
			return;
		}

		match = customId.match(/^temp:channel:select:(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const channelId = interaction.values?.[0];
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			if (!channelId || channelId === 'noop') {
				await interaction.deferUpdate().catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.#getLogger()?.warn({ err, userId: interaction.user.id }, 'Failed to defer interaction');
				});
				return;
			}
			const allowed = await this.#isExtraChannel(group.id, channelId);
			const panel = await this.#renderChannelsPanel(group, allowed ? channelId : null);
			await interaction.update({ embeds: [panel.embed], components: panel.components }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.#getLogger()?.warn({ err, userId: interaction.user.id, groupId: group.id }, 'Failed to send interaction reply');
			});
		}
	}

	async handleModal(interaction) {
		await this.ensureSchema();
		const customId = interaction?.customId || '';
		if (!customId.startsWith('temp:')) return;

		let match = customId.match(/^temp:event:edit:modal:(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			await this.#handleEventEditModal(interaction, group);
			return;
		}

		match = customId.match(/^temp:channel:create:modal:(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			await this.#handleChannelCreateModal(interaction, group);
			return;
		}

		match = customId.match(/^temp:channel:rename:modal:(\d+):(\d+)/);
		if (match) {
			const groupId = Number(match[1]);
			const channelId = match[2];
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			const allowed = await this.#isExtraChannel(group.id, channelId);
			if (!allowed) {
				await this.#reply(interaction, 'Salon non modifiable.');
				return;
			}
			await this.#handleChannelRenameModal(interaction, group, channelId);
			return;
		}

		const memberMatch = customId.match(/^temp:members:modal:(\d+)/);
		if (memberMatch) {
			const groupId = Number(memberMatch[1]);
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			await this.#handleMembersModal(interaction, group);
			return;
		}

		const channelsMatch = customId.match(/^temp:channels:modal:(\d+)/);
		if (channelsMatch) {
			const groupId = Number(channelsMatch[1]);
			const group = await this.#getGroup(groupId);
			if (!group) {
				await this.#reply(interaction, 'Groupe temporaire introuvable.');
				return;
			}
			if (!this.#canManageGroup(interaction, group)) {
				await this.#reply(interaction, 'Action réservée au staff.');
				return;
			}
			await this.#handleChannelsModal(interaction, group);
		}
	}

	async handleArchiveButtons(interaction) {
		return this.handleButton(interaction);
	}

	async sweepExpired() {
		await this.ensureSchema();
		const [rows] = await this.#safeQuery(
			'SELECT * FROM temp_groups WHERE archived = 0 AND expires_at <= NOW()'
		);
		for (const group of rows || []) {
			await this.archiveGroup(group).catch((err) => {
				this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to archive temp group');
			});
		}
	}

	async archiveGroup(group) {
		if (!group?.id) return;
		await this.#safeQuery('UPDATE temp_groups SET archived = 1 WHERE id = ?', [group.id]);

		const baseIds = new Set(
			[
				group.text_channel_id,
				group.voice_channel_id,
				group.panel_channel_id,
				group.category_id
			].filter(Boolean)
		);

		const extras = await this.#getExtraChannels(group.id).catch(() => []);
		for (const extra of extras || []) {
			if (baseIds.has(extra.channel_id)) continue;
			await this.#deleteExtraChannel(group, extra.channel_id).catch((err) => {
				this.#getLogger()?.warn({ err, channelId: extra.channel_id, groupId: group.id }, 'Failed to delete extra channel');
			});
		}
		await this.#safeQuery('DELETE FROM temp_group_channels WHERE temp_group_id = ?', [group.id]);

		const channelIds = [
			group.text_channel_id,
			group.voice_channel_id,
			group.panel_channel_id,
			group.category_id
		].filter(Boolean);
		for (const channelId of channelIds) {
			const channel = await this.#fetchChannel(channelId);
			if (channel) {
				await channel.delete('Temp group archived').catch((err) => {
					if (err?.code === 10003) return; // Unknown channel
					this.#getLogger()?.warn({ err, channelId, groupId: group.id }, 'Failed to delete channel');
				});
			}
		}
	}

	#parseButton(customId) {
		const match = String(customId || '').match(/^temp:(extend|delete):(\d+)/);
		if (!match) return null;
		return { action: match[1], groupId: match[2] };
	}

	async #getGroup(groupId) {
		const [rows] = await this.#safeQuery(
			`SELECT id, name, expires_at, archived, category_id, text_channel_id, voice_channel_id,
                        guild_id, panel_channel_id, panel_members_message_id, panel_channels_message_id, panel_event_message_id, panel_message_id, created_by, event_id
                         FROM temp_groups WHERE id = ?`,
			[groupId]
		);
		return rows?.[0] || null;
	}

	#computeExtension(expiresAt) {
		const rawHours = Number(process.env.TEMP_GROUP_EXTEND_HOURS);
		const hours = Number.isFinite(rawHours) && rawHours > 0 ? rawHours : 24;
		const now = new Date();
		const base = expiresAt ? new Date(expiresAt) : now;
		const start = base > now ? base : now;
		return new Date(start.getTime() + hours * 60 * 60 * 1000);
	}

	async ensurePanel(group) {
		if (!group?.id) return;
		const stored = await this.#getGroup(group.id);
		const resolved = stored || group;

		const panelChannelId = resolved.panel_channel_id || resolved.text_channel_id;
		if (!panelChannelId) return;
		const channel = await this.#fetchChannel(panelChannelId);
		if (!channel?.isTextBased?.()) return;

		const counts = await this.#getMemberCounts(resolved.id);

		const membersPanel = await this.#renderMembersPanel(resolved, counts);
		const channelsPanel = await this.#renderChannelsPanel(resolved);
		const eventPanel = await this.#renderEventPanel(resolved);

		const membersMessageId = await this.#upsertPanelMessage(
			channel,
			resolved.panel_members_message_id,
			membersPanel
		);
		const channelsMessageId = await this.#upsertPanelMessage(
			channel,
			resolved.panel_channels_message_id,
			channelsPanel
		);
		const eventMessageId = await this.#upsertPanelMessage(
			channel,
			resolved.panel_event_message_id || resolved.panel_message_id,
			eventPanel
		);

		await this.#safeQuery(
			`UPDATE temp_groups
                         SET panel_members_message_id = ?, panel_channels_message_id = ?, panel_event_message_id = ?, panel_message_id = ?
                         WHERE id = ?`,
			[membersMessageId, channelsMessageId, eventMessageId, eventMessageId, resolved.id]
		);
	}

	async #renderMembersPanel(group, counts, selection = null) {
		const participantPreview = await this.#getMemberPreview(group.id, 'participant', 20);
		const spectatorPreview = await this.#getMemberPreview(group.id, 'spectator', 20);

		const embed = new EmbedBuilder()
			.setTitle('Membres du groupe')
			.setDescription('Gere les participants et les spectateurs du groupe.')
			.addFields(
				{
					name: `Participants (${counts.participant})`,
					value: this.#formatMemberPreview(participantPreview, counts.participant),
					inline: false
				},
				{
					name: `Spectateurs (${counts.spectator})`,
					value: this.#formatMemberPreview(spectatorPreview, counts.spectator),
					inline: false
				}
			)
			.setColor(0x5865f2);

		if (selection?.userId) {
			const roleLabel = selection.role === 'spectator' ? 'spectateur' : 'participant';
			embed.addFields({
				name: 'Selection',
				value: `<@${selection.userId}> (${roleLabel})`,
				inline: false
			});
		}

		const participantRow = await this.#buildMemberSelectRow(group, 'participant', selection?.role === 'participant' ? selection?.userId : null);
		const spectatorRow = await this.#buildMemberSelectRow(group, 'spectator', selection?.role === 'spectator' ? selection?.userId : null);

		const rows = [participantRow, spectatorRow];

		if (selection?.userId) {
			const targetRole = selection.role === 'spectator' ? 'participant' : 'spectator';
			const switchLabel = selection.role === 'spectator' ? 'Basculer en participant' : 'Basculer en spectateur';
			const actionRow = new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`temp:member:remove:${group.id}:${selection.userId}`)
					.setLabel('Retirer')
					.setStyle(ButtonStyle.Danger),
				new ButtonBuilder()
					.setCustomId(`temp:member:switch:${group.id}:${selection.userId}:${targetRole}`)
					.setLabel(switchLabel)
					.setStyle(ButtonStyle.Secondary)
			);
			rows.push(actionRow);
		}

		return { embed, components: rows };
	}

	async #renderChannelsPanel(group, selectedChannelId = null) {
		const baseChannels = [
			group.panel_channel_id ? `Panel: <#${group.panel_channel_id}>` : null,
			group.text_channel_id ? `Texte: <#${group.text_channel_id}>` : null,
			group.voice_channel_id ? `Vocal: <#${group.voice_channel_id}>` : null,
			group.category_id ? `Categorie: <#${group.category_id}>` : null
		].filter(Boolean).join('\n') || 'n/a';

		const extras = await this.#getExtraChannels(group.id);
		const extrasValue = extras.length ? extras.map((row) => `<#${row.channel_id}>`).join('\n') : 'Aucun';

		const embed = new EmbedBuilder()
			.setTitle('Salons du groupe')
			.setDescription('Gere les salons additionnels. Les salons de base ne sont pas modifiables.')
			.addFields(
				{ name: 'Salons principaux', value: baseChannels, inline: false },
				{ name: 'Salons additionnels', value: extrasValue, inline: false }
			)
			.setColor(0x5865f2);

		if (selectedChannelId) {
			embed.addFields({ name: 'Selection', value: `<#${selectedChannelId}>`, inline: false });
		}

		const selectRow = await this.#buildChannelSelectRow(group, extras, selectedChannelId);
		const createRow = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`temp:channel:create:${group.id}`)
				.setLabel('Creer un salon')
				.setStyle(ButtonStyle.Primary)
		);

		const rows = [selectRow, createRow];

		if (selectedChannelId) {
			const actionRow = new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`temp:channel:rename:${group.id}:${selectedChannelId}`)
					.setLabel('Renommer')
					.setStyle(ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId(`temp:channel:delete:${group.id}:${selectedChannelId}`)
					.setLabel('Supprimer')
					.setStyle(ButtonStyle.Danger)
			);
			rows.push(actionRow);
		}

		return { embed, components: rows };
	}

	async #renderEventPanel(group) {
		const embed = new EmbedBuilder().setColor(0x5865f2);

		if (!group.event_id) {
			embed
				.setTitle('Evenement')
				.setDescription('Aucun evenement lie a ce groupe.');
		} else {
			const event = await this.#getEventDetails(group.event_id);
			if (!event) {
				embed
					.setTitle('Evenement')
					.setDescription('Evenement introuvable.');
			} else {
				const participantCount = await this.#countEventParticipants(event.id);
				const spectatorCount = await this.#countEventSpectators(event.id);
				const maxParticipants = Number(event.max_participants || 0);
				const maxLabel = Number.isFinite(maxParticipants) && maxParticipants > 0 ? ` / ${maxParticipants}` : '';

				embed
					.setTitle(`Evenement: ${event.name || 'Sans nom'}`)
					.setDescription('Gestion de l\'evenement et du groupe temporaire.')
					.addFields(
						{ name: 'Statut', value: String(event.status || 'n/a'), inline: true },
						{
							name: 'Participants',
							value: `${participantCount}${maxLabel}`,
							inline: true
						},
						{ name: 'Spectateurs', value: String(spectatorCount), inline: true }
					);

				if (event.scheduled_at) {
					embed.addFields({ name: 'Programme', value: this.#formatTimestamp(event.scheduled_at), inline: true });
				}
				if (event.starts_at) {
					embed.addFields({ name: 'Debut', value: this.#formatTimestamp(event.starts_at), inline: true });
				}
				if (event.ends_at) {
					embed.addFields({ name: 'Fin', value: this.#formatTimestamp(event.ends_at), inline: true });
				}
			}
		}

		const rows = [];
		if (group.event_id) {
			const editRow = new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`temp:event:edit:${group.id}`)
					.setLabel('Modifier l\'evenement')
					.setStyle(ButtonStyle.Primary),
				new ButtonBuilder()
					.setCustomId(`temp:event:refresh:${group.id}`)
					.setLabel('Rafraichir')
					.setStyle(ButtonStyle.Secondary)
			);
			rows.push(editRow);
		}

		const actionRow = new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`temp:extend:${group.id}`).setLabel('Prolonger').setStyle(ButtonStyle.Secondary),
			new ButtonBuilder().setCustomId(`temp:delete:${group.id}`).setLabel('Archiver').setStyle(ButtonStyle.Danger)
		);
		rows.push(actionRow);

		return { embed, components: rows };
	}

	async #upsertPanelMessage(channel, messageId, payload) {
		let message = null;
		const components = payload?.components || [];
		if (messageId) {
			message = await channel.messages.fetch(messageId).catch(() => null);
			if (message) {
				await message.edit({ embeds: [payload.embed], components }).catch((err) => {
					if (err?.code === 10008) return; // Unknown message
					this.#getLogger()?.warn({ err, messageId, channelId: channel.id }, 'Failed to edit message');
				});
			}
		}

		if (!message) {
			message = await channel.send({ embeds: [payload.embed], components }).catch(() => null);
		}

		return message?.id || null;
	}

	async #getMemberCounts(groupId) {
		const counts = { participant: 0, spectator: 0 };
		const [rows] = await this.#safeQuery(
			'SELECT role, COUNT(*) AS n FROM temp_group_members WHERE temp_group_id = ? GROUP BY role',
			[groupId]
		);
		for (const row of rows || []) {
			if (row?.role === 'spectator') {
				counts.spectator = Number(row.n || 0);
			} else if (row?.role === 'participant') {
				counts.participant = Number(row.n || 0);
			}
		}
		return counts;
	}

	async #getMemberPreview(groupId, role, limit = 20) {
		const [rows] = await this.#safeQuery(
			`SELECT user_id FROM temp_group_members
                         WHERE temp_group_id = ? AND role = ?
                         ORDER BY user_id LIMIT ${limit}`,
			[groupId, role]
		);
		return (rows || []).map((row) => row.user_id);
	}

	#formatMemberPreview(ids, total) {
		if (!total) return 'Aucun';
		const lines = (ids || []).map((id) => `<@${id}>`);
		if (total > lines.length) {
			lines.push(`+${total - lines.length} autres`);
		}
		return lines.join('\n');
	}

	async #buildMemberSelectRow(group, role, selectedUserId) {
		const options = await this.#getMemberSelectOptions(group, role, selectedUserId);
		const isParticipant = role === 'participant';
		const placeholder = isParticipant ? 'Choisir un participant' : 'Choisir un spectateur';

		const select = new StringSelectMenuBuilder()
			.setCustomId(`temp:member:select:${group.id}:${role}`)
			.setPlaceholder(placeholder)
			.setMinValues(1)
			.setMaxValues(1);

		if (options.length) {
			select.addOptions(options);
		} else {
			select
				.setDisabled(true)
				.addOptions({ label: isParticipant ? 'Aucun participant' : 'Aucun spectateur', value: 'noop' });
		}

		return new ActionRowBuilder().addComponents(select);
	}

	async #getMemberSelectOptions(group, role, selectedUserId) {
		const [rows] = await this.#safeQuery(
			`SELECT user_id FROM temp_group_members
                         WHERE temp_group_id = ? AND role = ?
                         ORDER BY user_id LIMIT 25`,
			[group.id, role]
		);

		const guild = group.guild_id ? this.client.guilds.cache.get(group.guild_id) : null;

		return (rows || []).map((row) => {
			const userId = row.user_id;
			const member = guild?.members?.cache?.get?.(userId) || null;
			const label = member?.displayName || member?.user?.username || userId;
			const description = member?.user?.tag ? member.user.tag.slice(0, 100) : undefined;
			return {
				label: String(label).slice(0, 100),
				value: userId,
				description,
				default: selectedUserId ? userId === selectedUserId : false
			};
		});
	}

	async #getExtraChannels(groupId) {
		const [rows] = await this.#safeQuery(
			'SELECT channel_id, kind FROM temp_group_channels WHERE temp_group_id = ? ORDER BY id',
			[groupId]
		);
		const result = [];
		for (const row of rows || []) {
			const channel = await this.#fetchChannel(row.channel_id);
			if (!channel) {
				await this.#safeQuery('DELETE FROM temp_group_channels WHERE channel_id = ?', [row.channel_id]);
				continue;
			}
			result.push({ channel_id: row.channel_id, kind: row.kind || 'text', channel });
		}
		return result;
	}

	async #buildChannelSelectRow(group, extras, selectedChannelId) {
		const select = new StringSelectMenuBuilder()
			.setCustomId(`temp:channel:select:${group.id}`)
			.setPlaceholder('Choisir un salon additionnel')
			.setMinValues(1)
			.setMaxValues(1);

		const options = (extras || []).slice(0, 25).map((row) => ({
			label: String(row.channel?.name || row.channel_id).slice(0, 100),
			value: row.channel_id,
			description: row.kind === 'voice' ? 'Vocal' : 'Texte',
			default: selectedChannelId ? row.channel_id === selectedChannelId : false
		}));

		if (options.length) {
			select.addOptions(options);
		} else {
			select
				.setDisabled(true)
				.addOptions({ label: 'Aucun salon additionnel', value: 'noop' });
		}

		return new ActionRowBuilder().addComponents(select);
	}

	#normalizeChannelKind(value) {
		const trimmed = String(value || '').trim().toLowerCase();
		if (!trimmed) return null;
		if (['text', 'texte', 'txt', 't', 'ecrit', 'message'].includes(trimmed)) return 'text';
		if (['voice', 'vocal', 'voc', 'audio', 'v'].includes(trimmed)) return 'voice';
		return null;
	}

	#normalizeChannelName(value, kind) {
		const trimmed = String(value || '').trim();
		if (!trimmed) return null;
		if (kind === 'text') {
			const slug = this.#slugify(trimmed, 100);
			return slug || null;
		}
		const cleaned = trimmed.replace(/\s+/g, ' ').slice(0, 100);
		return cleaned || null;
	}

	async #createExtraChannel(group, name, kind) {
		const category = group.category_id ? await this.#fetchChannel(group.category_id) : null;
		let guild = null;
		if (group.guild_id) {
			guild = await this.client.guilds.fetch(group.guild_id).catch(() => null);
		}
		if (!guild && category?.guild) {
			guild = category.guild;
		}
		if (!guild) return null;

		const type = kind === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
		const payload = {
			name,
			type,
			parent: category?.id,
			reason: 'Temp group extra channel'
		};

		if (!payload.parent) {
			payload.permissionOverwrites = await this.#buildBaseOverwrites(guild, group.created_by);
		}

		const channel = await guild.channels.create(payload).catch(() => null);
		if (!channel) return null;

		await this.#safeQuery(
			`INSERT INTO temp_group_channels (temp_group_id, channel_id, kind)
                         VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE kind = VALUES(kind)`,
			[group.id, channel.id, kind]
		);

		return channel;
	}

	async #deleteExtraChannel(group, channelId) {
		await this.#safeQuery('DELETE FROM temp_group_channels WHERE temp_group_id = ? AND channel_id = ?', [
			group.id,
			channelId
		]);

		const channel = await this.#fetchChannel(channelId);
		if (channel) {
			await channel.delete('Temp group extra channel removed').catch((err) => {
				if (err?.code === 10003) return; // Unknown channel
				this.#getLogger()?.warn({ err, channelId, groupId: group.id }, 'Failed to delete channel');
			});
		}
	}

	async #isExtraChannel(groupId, channelId) {
		const [rows] = await this.#safeQuery(
			'SELECT channel_id FROM temp_group_channels WHERE temp_group_id = ? AND channel_id = ? LIMIT 1',
			[groupId, channelId]
		);
		return Boolean(rows?.length);
	}

	async #getEventDetails(eventId) {
		const [rows] = await this.#safeQuery(
			`SELECT id, name, description, status, scheduled_at, starts_at, ends_at, min_participants, max_participants,
                        message_content, embed_color, game
                         FROM events WHERE id = ?`,
			[eventId]
		);
		return rows?.[0] || null;
	}

	async #countEventSpectators(eventId) {
		const [rows] = await this.#safeQuery(
			"SELECT COUNT(*) AS n FROM event_participants WHERE event_id = ? AND role = 'spectator'",
			[eventId]
		);
		return Number(rows?.[0]?.n || 0);
	}

	#parseParticipants(raw) {
		const value = String(raw || '').trim();
		if (!value) return { min: null, max: null };

		let min = null;
		let max = null;

		const minMatch = value.match(/min\s*=\s*(\d+)/i);
		const maxMatch = value.match(/max\s*=\s*(\d+)/i);
		if (minMatch) min = Number(minMatch[1]);
		if (maxMatch) max = Number(maxMatch[1]);

		if (!minMatch && !maxMatch) {
			const pairMatch = value.match(/(\d+)\s*\/\s*(\d+)/);
			if (pairMatch) {
				min = Number(pairMatch[1]);
				max = Number(pairMatch[2]);
			} else if (/^\d+$/.test(value)) {
				max = Number(value);
			}
		}

		if (min && max && min > max) {
			[min, max] = [max, min];
		}

		return {
			min: Number.isFinite(min) && min > 0 ? min : null,
			max: Number.isFinite(max) && max > 0 ? max : null
		};
	}

	#formatParticipants(existing) {
		if (!existing) return '';
		const min = existing.min_participants ? Number(existing.min_participants) : null;
		const max = existing.max_participants ? Number(existing.max_participants) : null;
		if (!min && !max) return '';
		if (min && max) return `min=${min} max=${max}`;
		if (min) return `min=${min}`;
		return `max=${max}`;
	}

	#normalizeColor(value) {
		if (!value) return null;
		const trimmed = String(value).trim().replace(/^#/, '');
		if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
		return `#${trimmed.toUpperCase()}`;
	}

	#parseOptions(raw) {
		const result = {};
		if (!raw) return result;
		for (const line of String(raw).split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const eq = trimmed.indexOf('=');
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim().toLowerCase();
			const value = trimmed.slice(eq + 1).trim();
			if (!key || !value) continue;
			result[key] = value;
		}
		return result;
	}

	#formatEventOptions(existing) {
		if (!existing) return '';
		const lines = [];
		if (existing.message_content) {
			lines.push(`tag=${String(existing.message_content).replace(/\s+/g, ' ').slice(0, 128)}`);
		}
		if (existing.game) lines.push(`jeu=${String(existing.game).slice(0, 120)}`);
		return lines.join('\n');
	}

	#formatTimestamp(value) {
		const date = value instanceof Date ? value : new Date(value);
		if (Number.isNaN(date.getTime())) return 'n/a';
		const unix = Math.floor(date.getTime() / 1000);
		return `<t:${unix}:F>`;
	}

	#buildChannelCreateModal(group) {
		const modal = new ModalBuilder()
			.setCustomId(`temp:channel:create:modal:${group.id}`)
			.setTitle('Creer un salon');

		const nameInput = new TextInputBuilder()
			.setCustomId('tempChannelName')
			.setLabel('Nom du salon')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(100);

		const typeInput = new TextInputBuilder()
			.setCustomId('tempChannelType')
			.setLabel('Type (texte/vocal)')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(16)
			.setPlaceholder('texte');

		modal.addComponents(
			new ActionRowBuilder().addComponents(nameInput),
			new ActionRowBuilder().addComponents(typeInput)
		);

		return modal;
	}

	async #buildChannelRenameModal(group, channelId) {
		const modal = new ModalBuilder()
			.setCustomId(`temp:channel:rename:modal:${group.id}:${channelId}`)
			.setTitle('Renommer un salon');

		const nameInput = new TextInputBuilder()
			.setCustomId('tempChannelRename')
			.setLabel('Nouveau nom')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(100);

		const channel = await this.#fetchChannel(channelId);
		if (channel?.name) {
			nameInput.setValue(String(channel.name).slice(0, 100));
		}

		modal.addComponents(new ActionRowBuilder().addComponents(nameInput));

		return modal;
	}

	#buildEventEditModal(group, event) {
		const modal = new ModalBuilder()
			.setCustomId(`temp:event:edit:modal:${group.id}`)
			.setTitle('Modifier l\'evenement');

		const nameInput = new TextInputBuilder()
			.setCustomId('tempEventName')
			.setLabel('Titre')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(120)
			.setValue(event?.name || '');

		const descriptionInput = new TextInputBuilder()
			.setCustomId('tempEventDescription')
			.setLabel('Description')
			.setStyle(TextInputStyle.Paragraph)
			.setRequired(false)
			.setMaxLength(4000)
			.setValue(event?.description || '');

		const colorInput = new TextInputBuilder()
			.setCustomId('tempEventColor')
			.setLabel('Couleur (#RRGGBB)')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(16)
			.setPlaceholder('#5865F2')
			.setValue(event?.embed_color || '');

		const participantsInput = new TextInputBuilder()
			.setCustomId('tempEventParticipants')
			.setLabel('Participants (min=/max=)')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(64)
			.setPlaceholder('min=5 max=20')
			.setValue(this.#formatParticipants(event));

		const optionsInput = new TextInputBuilder()
			.setCustomId('tempEventOptions')
			.setLabel('Tag / Jeu')
			.setStyle(TextInputStyle.Paragraph)
			.setRequired(false)
			.setMaxLength(600)
			.setPlaceholder('tag=Roleplay\njeu=Nom du jeu')
			.setValue(this.#formatEventOptions(event));

		modal.addComponents(
			new ActionRowBuilder().addComponents(nameInput),
			new ActionRowBuilder().addComponents(descriptionInput),
			new ActionRowBuilder().addComponents(colorInput),
			new ActionRowBuilder().addComponents(participantsInput),
			new ActionRowBuilder().addComponents(optionsInput)
		);

		return modal;
	}

	async #handleEventEditModal(interaction, group) {
		if (!group?.event_id) {
			await this.#reply(interaction, 'Evenement introuvable.');
			return;
		}

		const name = interaction.fields.getTextInputValue('tempEventName')?.trim() || '';
		const description = interaction.fields.getTextInputValue('tempEventDescription')?.trim() || null;
		const colorRaw = interaction.fields.getTextInputValue('tempEventColor')?.trim() || '';
		const participantsRaw = interaction.fields.getTextInputValue('tempEventParticipants')?.trim() || '';
		const optionsRaw = interaction.fields.getTextInputValue('tempEventOptions')?.trim() || '';

		if (!name) {
			await this.#reply(interaction, 'Le titre est obligatoire.');
			return;
		}

		const embedColor = colorRaw ? this.#normalizeColor(colorRaw) : null;
		if (colorRaw && !embedColor) {
			await this.#reply(interaction, 'Couleur invalide. Utilise le format #RRGGBB.');
			return;
		}

		const limits = this.#parseParticipants(participantsRaw);
		const options = this.#parseOptions(optionsRaw);
		const tagRaw = options.tag || options.type || '';
		const tagValue = tagRaw ? String(tagRaw).trim().slice(0, 128) : null;
		const gameRaw = options.jeu || options['jeu.x'] || options.game || options.jeux || '';
		const game = gameRaw ? String(gameRaw).trim().slice(0, 120) : null;

		await this.#safeQuery(
			`UPDATE events
                         SET name = ?, description = ?, embed_color = ?, min_participants = ?, max_participants = ?, message_content = ?, game = ?
                         WHERE id = ?`,
			[
				name,
				description,
				embedColor,
				limits.min,
				limits.max,
				tagValue,
				game,
				group.event_id
			]
		);

		await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
		await this.client?.context?.services?.staffPanel?.refreshEventMessages?.(group.event_id).catch((err) => {
			this.#getLogger()?.warn({ err, eventId: group.event_id }, 'Failed to refresh event messages');
		});
		await this.#reply(interaction, 'Evenement mis a jour.');
	}

	async #handleChannelCreateModal(interaction, group) {
		const nameRaw = interaction.fields.getTextInputValue('tempChannelName')?.trim() || '';
		const typeRaw = interaction.fields.getTextInputValue('tempChannelType')?.trim() || '';
		const kind = this.#normalizeChannelKind(typeRaw);
		if (!kind) {
			await this.#reply(interaction, 'Type invalide. Utilise "texte" ou "vocal".');
			return;
		}

		const name = this.#normalizeChannelName(nameRaw, kind);
		if (!name) {
			await this.#reply(interaction, 'Nom de salon invalide.');
			return;
		}

		const channel = await this.#createExtraChannel(group, name, kind);
		if (!channel) {
			await this.#reply(interaction, 'Impossible de creer le salon.');
			return;
		}

		await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
		await this.#reply(interaction, `Salon cree: <#${channel.id}>`);
	}

	async #handleChannelRenameModal(interaction, group, channelId) {
		const nameRaw = interaction.fields.getTextInputValue('tempChannelRename')?.trim() || '';
		if (!nameRaw) {
			await this.#reply(interaction, 'Nom de salon invalide.');
			return;
		}

		const channel = await this.#fetchChannel(channelId);
		if (!channel) {
			await this.#reply(interaction, 'Salon introuvable.');
			return;
		}

		const kind = channel.type === ChannelType.GuildVoice ? 'voice' : 'text';
		const name = this.#normalizeChannelName(nameRaw, kind);
		if (!name) {
			await this.#reply(interaction, 'Nom de salon invalide.');
			return;
		}

		if (channel.name !== name) {
			await channel.setName(name).catch((err) => {
				if (err?.code === 10003) return; // Unknown channel
				this.#getLogger()?.warn({ err, channelId, groupId: group.id }, 'Failed to edit channel');
			});
		}

		await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});
		await this.#reply(interaction, 'Salon mis a jour.');
	}

	async #handleMembersModal(interaction, group) {
		const userRaw = interaction.fields.getTextInputValue('tempMemberUser')?.trim() || '';
		const roleRaw = interaction.fields.getTextInputValue('tempMemberRole')?.trim() || '';
		const actionRaw = interaction.fields.getTextInputValue('tempMemberAction')?.trim() || '';

		const userId = this.#extractUserId(userRaw);
		if (!userId) {
			await this.#reply(interaction, 'Utilisateur invalide.');
			return;
		}

		const action = this.#normalizeMemberAction(actionRaw) || 'set';
		const desiredRole = this.#normalizeMemberRole(roleRaw);
		const existingRole = await this.#getMemberRole(group.id, userId);

		const eventId = group.event_id ? Number(group.event_id) : null;
		let existingEventRole = null;
		if (eventId) {
			await this.client?.context?.services?.event?.ensureSchema?.().catch((err) => {
				this.#getLogger()?.warn({ err }, 'Failed to ensure event schema');
			});
			existingEventRole = await this.#getEventParticipantRole(eventId, userId);
		}

		if (action === 'remove') {
			await this.removeMember(group.id, userId, { guildId: group.guild_id });
			if (eventId) {
				await this.#removeEventParticipant(eventId, userId);
			}
			await this.#reply(interaction, 'Membre retire.');
			return;
		}

		let targetRole = desiredRole || 'participant';
		if (action === 'toggle') {
			if (desiredRole) {
				targetRole = desiredRole;
			} else if (existingRole) {
				targetRole = existingRole === 'participant' ? 'spectator' : 'participant';
			}
		}

		const guildMember = await this.#fetchGuildMember(group, userId);
		if (!guildMember) {
			await this.#reply(interaction, 'Membre introuvable.');
			return;
		}

		if (eventId) {
			const eventMeta = await this.#getEventMeta(eventId);
			const maxParticipants = Number(eventMeta?.max_participants || 0);
			const hasMax = Number.isFinite(maxParticipants) && maxParticipants > 0;
			if (targetRole === 'participant' && hasMax && existingEventRole !== 'participant') {
				const count = await this.#countEventParticipants(eventId);
				if (count >= maxParticipants) {
					await this.#reply(interaction, 'Nombre maximal de participants atteint.');
					return;
				}
			}

			const eventUpdate = await this.#setEventParticipantRole(eventId, userId, targetRole);
			if (!eventUpdate.ok) {
				await this.#reply(interaction, eventUpdate.message || 'Impossible de mettre a jour l\'evenement.');
				return;
			}
		}

		try {
			await this.setMemberRole(group.id, userId, targetRole, { guildId: group.guild_id });
		} catch (err) {
			this.#getLogger()?.warn({ err, groupId: group.id, userId }, 'Failed to update temp group member');
			await this.#reply(interaction, 'Impossible de mettre a jour ce membre.');
			return;
		}

		const label = targetRole === 'spectator' ? 'spectateur' : 'participant';
		await this.#reply(interaction, `Membre mis a jour (${label}).`);
	}

	async #handleChannelsModal(interaction, group) {
		const textRaw = interaction.fields.getTextInputValue('tempChannelText')?.trim() || '';
		const voiceRaw = interaction.fields.getTextInputValue('tempChannelVoice')?.trim() || '';
		const panelRaw = interaction.fields.getTextInputValue('tempChannelPanel')?.trim() || '';

		const updates = [];

		if (textRaw && group.text_channel_id) {
			const channel = await this.#fetchChannel(group.text_channel_id);
			const name = this.#slugify(textRaw) || null;
			if (channel && name && channel.name !== name) {
				await channel.setName(name).catch((err) => {
					if (err?.code === 10003) return; // Unknown channel
					this.#getLogger()?.warn({ err, channelId: group.text_channel_id, groupId: group.id }, 'Failed to edit channel');
				});
				updates.push(`Texte -> ${name}`);
			}
		}

		if (voiceRaw && group.voice_channel_id) {
			const channel = await this.#fetchChannel(group.voice_channel_id);
			const name = voiceRaw.slice(0, 100);
			if (channel && name && channel.name !== name) {
				await channel.setName(name).catch((err) => {
					if (err?.code === 10003) return; // Unknown channel
					this.#getLogger()?.warn({ err, channelId: group.voice_channel_id, groupId: group.id }, 'Failed to edit channel');
				});
				updates.push(`Vocal -> ${name}`);
			}
		}

		if (panelRaw && group.panel_channel_id) {
			const channel = await this.#fetchChannel(group.panel_channel_id);
			const name = this.#slugify(panelRaw) || null;
			if (channel && name && channel.name !== name) {
				await channel.setName(name).catch((err) => {
					if (err?.code === 10003) return; // Unknown channel
					this.#getLogger()?.warn({ err, channelId: group.panel_channel_id, groupId: group.id }, 'Failed to edit channel');
				});
				updates.push(`Panel -> ${name}`);
			}
		}

		await this.ensurePanel(group).catch((err) => {
			this.#getLogger()?.warn({ err, groupId: group.id }, 'Failed to refresh temp group panel');
		});

		if (!updates.length) {
			await this.#reply(interaction, 'Aucun changement.');
			return;
		}

		await this.#reply(interaction, `Salons mis a jour: ${updates.join(', ')}`);
	}

	async #applyMemberPermissions(group, member, role, { allowPanel = false } = {}) {
		const category = await this.#fetchChannel(group.category_id);
		const textChannel = await this.#fetchChannel(group.text_channel_id);
		const voiceChannel = await this.#fetchChannel(group.voice_channel_id);
		const panelChannel = await this.#fetchChannel(group.panel_channel_id);

		if (category) {
			await category.permissionOverwrites.edit(member.id, { ViewChannel: true }).catch((err) => {
				this.#getLogger()?.error({ err, channelId: category.id, userId: member.id, groupId: group.id }, 'Failed to update permissions');
			});
		}

		const isSpectator = role === 'spectator';
		if (textChannel) {
			await textChannel.permissionOverwrites
				.edit(member.id, {
					ViewChannel: true,
					ReadMessageHistory: true,
					SendMessages: !isSpectator
				})
				.catch((err) => {
					this.#getLogger()?.error({ err, channelId: textChannel.id, userId: member.id, groupId: group.id }, 'Failed to update permissions');
				});
		}

		if (voiceChannel) {
			await voiceChannel.permissionOverwrites
				.edit(member.id, {
					ViewChannel: true,
					Connect: true,
					Speak: !isSpectator
				})
				.catch((err) => {
					this.#getLogger()?.error({ err, channelId: voiceChannel.id, userId: member.id, groupId: group.id }, 'Failed to update permissions');
				});
		}

		if (panelChannel) {
			const panelPerms = allowPanel
				? { ViewChannel: true, ReadMessageHistory: true }
				: { ViewChannel: false };
			await panelChannel.permissionOverwrites
				.edit(member.id, panelPerms)
				.catch((err) => {
					this.#getLogger()?.error({ err, channelId: panelChannel.id, userId: member.id, groupId: group.id }, 'Failed to update permissions');
				});
		}
	}

	async #clearMemberPermissions(group, memberId) {
		const channels = [
			group.category_id,
			group.text_channel_id,
			group.voice_channel_id,
			group.panel_channel_id
		].filter(Boolean);
		for (const channelId of channels) {
			const channel = await this.#fetchChannel(channelId);
			if (channel) {
				await channel.permissionOverwrites.delete(memberId).catch((err) => {
					this.#getLogger()?.error({ err, channelId, userId: memberId, groupId: group.id }, 'Failed to update permissions');
				});
			}
		}
	}

	#normalizeMemberRole(value) {
		const trimmed = String(value || '').trim().toLowerCase();
		if (!trimmed) return null;
		if (['participant', 'player', 'joueur', 'joueuse', 'part'].includes(trimmed)) {
			return 'participant';
		}
		if (['spectateur', 'spectator', 'viewer', 'spec', 'spectatrice'].includes(trimmed)) {
			return 'spectator';
		}
		return null;
	}

	#normalizeMemberAction(value) {
		const trimmed = String(value || '').trim().toLowerCase();
		if (!trimmed) return null;
		if (['remove', 'delete', 'supprimer', 'retirer', 'kick'].includes(trimmed)) {
			return 'remove';
		}
		if (['toggle', 'switch', 'basculer', 'swap'].includes(trimmed)) {
			return 'toggle';
		}
		if (['add', 'ajouter', 'set', 'assign', 'update'].includes(trimmed)) {
			return 'set';
		}
		return null;
	}

	#extractUserId(value) {
		const match = String(value || '').match(/(\d{17,20})/);
		return match ? match[1] : null;
	}

	async #getMemberRole(groupId, userId) {
		const [rows] = await this.#safeQuery(
			'SELECT role FROM temp_group_members WHERE temp_group_id = ? AND user_id = ? LIMIT 1',
			[groupId, userId]
		);
		return rows?.[0]?.role || null;
	}

	async #getEventMeta(eventId) {
		const [rows] = await this.#safeQuery('SELECT id, max_participants FROM events WHERE id = ?', [eventId]);
		return rows?.[0] || null;
	}

	async #getEventParticipantRole(eventId, userId) {
		const [rows] = await this.#safeQuery(
			'SELECT role FROM event_participants WHERE event_id = ? AND user_id = ? LIMIT 1',
			[eventId, userId]
		);
		return rows?.[0]?.role || null;
	}

	async #countEventParticipants(eventId) {
		const [rows] = await this.#safeQuery(
			"SELECT COUNT(*) AS n FROM event_participants WHERE event_id = ? AND role = 'participant'",
			[eventId]
		);
		return Number(rows?.[0]?.n || 0);
	}

	async #setEventParticipantRole(eventId, userId, role) {
		const existingRole = await this.#getEventParticipantRole(eventId, userId);
		if (existingRole) {
			await this.#safeQuery(
				'UPDATE event_participants SET role = ? WHERE event_id = ? AND user_id = ?',
				[role, eventId, userId]
			);
			return { ok: true };
		}

		const zoneId = await this.#resolveZoneIdForUser(userId);
		if (!zoneId) {
			return { ok: false, message: 'Zone introuvable pour ce membre.' };
		}

		await this.#safeQuery(
			'INSERT INTO event_participants (event_id, user_id, zone_id, role) VALUES (?, ?, ?, ?)',
			[eventId, userId, zoneId, role]
		);

		return { ok: true };
	}

	async #removeEventParticipant(eventId, userId) {
		await this.#safeQuery('DELETE FROM event_participants WHERE event_id = ? AND user_id = ?', [eventId, userId]);
	}

	async #resolveZoneIdForUser(userId) {
		const [rows] = await this.#safeQuery('SELECT zone_id FROM zone_members WHERE user_id = ?', [userId]);
		if (!rows || rows.length !== 1) return null;
		return rows[0].zone_id || null;
	}

	async #fetchGuildMember(group, userId) {
		const guildId = group?.guild_id;
		if (!guildId) return null;
		const guild = await this.client.guilds.fetch(guildId).catch(() => null);
		if (!guild) return null;
		return guild.members.fetch(userId).catch(() => null);
	}

	async #buildBaseOverwrites(guild, createdBy) {
		const overwrites = [
			{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
		];

		const botMember =
			guild.members.me || (await guild.members.fetch(this.client.user.id).catch(() => null));
		const botId = botMember?.id || this.client.user.id;
		overwrites.push({
			id: botId,
			allow: [
				PermissionFlagsBits.ViewChannel,
				PermissionFlagsBits.SendMessages,
				PermissionFlagsBits.ReadMessageHistory,
				PermissionFlagsBits.ManageChannels,
				PermissionFlagsBits.ManageMessages,
				PermissionFlagsBits.Connect,
				PermissionFlagsBits.Speak
			]
		});

		const modRoleId = this.client?.context?.config?.modRoleId || process.env.MOD_ROLE_ID;
		if (modRoleId) {
			const modRole = guild.roles.cache.get(modRoleId) || (await guild.roles.fetch(modRoleId).catch(() => null));
			if (modRole) {
				overwrites.push({
					id: modRole.id,
					allow: [
						PermissionFlagsBits.ViewChannel,
						PermissionFlagsBits.SendMessages,
						PermissionFlagsBits.ReadMessageHistory,
						PermissionFlagsBits.Connect,
						PermissionFlagsBits.Speak
					]
				});
			}
		}

		if (createdBy) {
			overwrites.push({
				id: createdBy,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.SendMessages,
					PermissionFlagsBits.ReadMessageHistory,
					PermissionFlagsBits.Connect,
					PermissionFlagsBits.Speak
				]
			});
		}

		return overwrites;
	}

	#normalizeExpiry(expiresAt) {
		if (expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime())) return expiresAt;
		return this.#computeExtension(new Date());
	}

	#slugify(value, limit = 32) {
		const max = Number.isFinite(limit) && limit > 0 ? limit : 32;
		return String(value || '')
			.toLowerCase()
			.normalize('NFD')
			.replace(/\p{Diacritic}/gu, '')
			.replace(/[^a-z0-9\s-]/g, '')
			.trim()
			.replace(/\s+/g, '-')
			.slice(0, max);
	}

	async #fetchChannel(id) {
		if (!id) return null;
		try {
			return await this.client.channels.fetch(id);
		} catch {
			return null;
		}
	}

	async #safeQuery(sql, params) {
		try {
			return await this.db.query(sql, params);
		} catch (err) {
			if (err?.code === 'ER_NO_SUCH_TABLE' || err?.code === 'ER_BAD_FIELD_ERROR') {
				this.#getLogger()?.warn({ err }, 'Temp group tables missing or incompatible');
				return [[], []];
			}
			throw err;
		}
	}

	async #reply(interaction, content) {
		if (!interaction) return;
		const payload = { content, flags: MessageFlags.Ephemeral };
		if (!interaction.deferred && !interaction.replied) {
			await interaction.reply(payload).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.#getLogger()?.warn({ err, userId: interaction.user.id }, 'Failed to send interaction reply');
			});
			return;
		}
		if (interaction.deferred && !interaction.replied) {
			const clean = { ...payload };
			if ('flags' in clean) delete clean.flags;
			await interaction.editReply(clean).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.#getLogger()?.warn({ err, userId: interaction.user.id }, 'Failed to send interaction reply');
			});
			return;
		}
		await interaction.followUp(payload).catch((err) => {
			if (err?.code === 10062 || err?.rawError?.code === 10062) return;
			this.#getLogger()?.warn({ err, userId: interaction.user.id }, 'Failed to send interaction reply');
		});
	}

	async #deferReply(interaction) {
		if (!interaction || interaction.deferred || interaction.replied) return;
		await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch((err) => {
			if (err?.code === 10062 || err?.rawError?.code === 10062) return;
			this.#getLogger()?.warn({ err, userId: interaction.user.id }, 'Failed to defer interaction');
		});
	}

	#getLogger() {
		return this.logger || this.client?.context?.logger || null;
	}

	#canManageGroup(interaction, group) {
		const ownerId = this.client?.context?.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID;
		if (ownerId && String(interaction.user.id) === String(ownerId)) return true;
		if (group?.created_by && String(group.created_by) === String(interaction.user.id)) return true;
		const modRoleId = this.client?.context?.config?.modRoleId || process.env.MOD_ROLE_ID;
		if (modRoleId && interaction.member?.roles?.cache?.has?.(modRoleId)) return true;
		return Boolean(interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator));
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

module.exports = { TempGroupService };
