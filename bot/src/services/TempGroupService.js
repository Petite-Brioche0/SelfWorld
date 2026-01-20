const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
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
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch(() => {});

		await this.db.query(`CREATE TABLE IF NOT EXISTS temp_group_members (
                        temp_group_id BIGINT UNSIGNED NOT NULL,
                        user_id VARCHAR(32) NOT NULL,
                        role ENUM('participant','spectator') NOT NULL DEFAULT 'participant',
                        PRIMARY KEY(temp_group_id, user_id),
                        FOREIGN KEY(temp_group_id) REFERENCES temp_groups(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch(() => {});

		const addColumnIfMissing = async (column, ddl) => {
			const exists = await this.#columnExists('temp_groups', column);
			if (!exists) {
				await this.db.query(`ALTER TABLE temp_groups ADD COLUMN ${ddl}`).catch(() => {});
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
				await this.db.query(`ALTER TABLE temp_group_members ADD COLUMN ${ddl}`).catch(() => {});
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
			await this.ensurePanel(group).catch(() => {});
		}
		return group;
	}

	async addMember(groupId, userId, { guildId = null, role = 'participant' } = {}) {
		return this.setMemberRole(groupId, userId, role, { guildId });
	}

	async setMemberRole(groupId, userId, role, { guildId = null } = {}) {
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

		await this.#applyMemberPermissions(group, member, normalizedRole);

		await this.#safeQuery(
			`INSERT INTO temp_group_members (temp_group_id, user_id, role)
                         VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE role = VALUES(role)`,
			[groupId, member.id, normalizedRole]
		);

		await this.ensurePanel(group).catch(() => {});
		return { group, role: normalizedRole };
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
		await this.ensurePanel(group).catch(() => {});
	}

	async handleButton(interaction) {
		await this.ensureSchema();
		const parsed = this.#parseButton(interaction?.customId);
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

		if (parsed.action === 'members') {
			const modal = this.#buildMembersModal(group);
			await interaction.showModal(modal);
			return;
		}

		if (parsed.action === 'channels') {
			const modal = await this.#buildChannelsModal(group);
			await interaction.showModal(modal);
			return;
		}

		if (parsed.action === 'extend') {
			const newExpiry = this.#computeExtension(group.expires_at);
			await this.#safeQuery('UPDATE temp_groups SET expires_at = ?, archived = 0 WHERE id = ?', [
				newExpiry,
				parsed.groupId
			]);
			await this.ensurePanel({ ...group, expires_at: newExpiry }).catch(() => {});
			await this.#reply(interaction, 'Expiration prolongee.');
			return;
		}

		if (parsed.action === 'delete') {
			await this.archiveGroup(group);
			await this.#reply(interaction, 'Groupe archive.');
		}
	}

	async handleModal(interaction) {
		await this.ensureSchema();
		const customId = interaction?.customId || '';
		if (!customId.startsWith('temp:')) return;

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
			await this.archiveGroup(group).catch(() => {});
		}
	}

	async archiveGroup(group) {
		if (!group?.id) return;
		await this.#safeQuery('UPDATE temp_groups SET archived = 1 WHERE id = ?', [group.id]);

		const channelIds = [
			group.text_channel_id,
			group.voice_channel_id,
			group.panel_channel_id,
			group.category_id
		].filter(Boolean);
		for (const channelId of channelIds) {
			const channel = await this.#fetchChannel(channelId);
			if (channel) {
				await channel.delete('Temp group archived').catch(() => {});
			}
		}
	}

	#parseButton(customId) {
		const match = String(customId || '').match(/^temp:(extend|delete|members|channels):(\d+)/);
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

	async #renderMembersPanel(group, counts) {
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

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`temp:members:${group.id}`)
				.setLabel('Gerer les membres')
				.setStyle(ButtonStyle.Primary)
		);

		return { embed, components: [row] };
	}

	async #renderChannelsPanel(group) {
		const channelsValue = [
			group.panel_channel_id ? `Panel: <#${group.panel_channel_id}>` : null,
			group.text_channel_id ? `Texte: <#${group.text_channel_id}>` : null,
			group.voice_channel_id ? `Vocal: <#${group.voice_channel_id}>` : null,
			group.category_id ? `Categorie: <#${group.category_id}>` : null
		].filter(Boolean).join('\n') || 'n/a';

		const embed = new EmbedBuilder()
			.setTitle('Salons du groupe')
			.setDescription('Renomme les salons si besoin.')
			.addFields({ name: 'Salons', value: channelsValue, inline: false })
			.setColor(0x5865f2);

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`temp:channels:${group.id}`)
				.setLabel('Gerer les salons')
				.setStyle(ButtonStyle.Secondary)
		);

		return { embed, components: [row] };
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

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`temp:extend:${group.id}`).setLabel('Prolonger').setStyle(ButtonStyle.Secondary),
			new ButtonBuilder().setCustomId(`temp:delete:${group.id}`).setLabel('Archiver').setStyle(ButtonStyle.Danger)
		);

		return { embed, components: [row] };
	}

	async #upsertPanelMessage(channel, messageId, payload) {
		let message = null;
		const components = payload?.components || [];
		if (messageId) {
			message = await channel.messages.fetch(messageId).catch(() => null);
			if (message) {
				await message.edit({ embeds: [payload.embed], components }).catch(() => {});
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

	async #getEventDetails(eventId) {
		const [rows] = await this.#safeQuery(
			'SELECT id, name, status, scheduled_at, starts_at, ends_at, min_participants, max_participants FROM events WHERE id = ?',
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

	#formatTimestamp(value) {
		const date = value instanceof Date ? value : new Date(value);
		if (Number.isNaN(date.getTime())) return 'n/a';
		const unix = Math.floor(date.getTime() / 1000);
		return `<t:${unix}:F>`;
	}

	#buildMembersModal(group) {
		const modal = new ModalBuilder()
			.setCustomId(`temp:members:modal:${group.id}`)
			.setTitle('Gerer les membres');

		const userInput = new TextInputBuilder()
			.setCustomId('tempMemberUser')
			.setLabel('Utilisateur (ID ou mention)')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(32)
			.setPlaceholder('123456789012345678');

		const roleInput = new TextInputBuilder()
			.setCustomId('tempMemberRole')
			.setLabel('Role (participant/spectateur)')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(32)
			.setPlaceholder('participant');

		const actionInput = new TextInputBuilder()
			.setCustomId('tempMemberAction')
			.setLabel('Action (ajouter/supprimer/basculer)')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(32)
			.setPlaceholder('ajouter');

		modal.addComponents(
			new ActionRowBuilder().addComponents(userInput),
			new ActionRowBuilder().addComponents(roleInput),
			new ActionRowBuilder().addComponents(actionInput)
		);

		return modal;
	}

	async #buildChannelsModal(group) {
		const modal = new ModalBuilder()
			.setCustomId(`temp:channels:modal:${group.id}`)
			.setTitle('Gerer les salons');

		const textInput = new TextInputBuilder()
			.setCustomId('tempChannelText')
			.setLabel('Salon texte')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(100);

		const voiceInput = new TextInputBuilder()
			.setCustomId('tempChannelVoice')
			.setLabel('Salon vocal')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(100);

		const panelInput = new TextInputBuilder()
			.setCustomId('tempChannelPanel')
			.setLabel('Salon panel')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(100);

		const textChannel = await this.#fetchChannel(group.text_channel_id);
		const voiceChannel = await this.#fetchChannel(group.voice_channel_id);
		const panelChannel = await this.#fetchChannel(group.panel_channel_id);

		if (textChannel?.name) textInput.setValue(textChannel.name.slice(0, 100));
		if (voiceChannel?.name) voiceInput.setValue(voiceChannel.name.slice(0, 100));
		if (panelChannel?.name) panelInput.setValue(panelChannel.name.slice(0, 100));

		modal.addComponents(
			new ActionRowBuilder().addComponents(textInput),
			new ActionRowBuilder().addComponents(voiceInput),
			new ActionRowBuilder().addComponents(panelInput)
		);

		return modal;
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
			await this.client?.context?.services?.event?.ensureSchema?.().catch(() => {});
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
				await channel.setName(name).catch(() => {});
				updates.push(`Texte -> ${name}`);
			}
		}

		if (voiceRaw && group.voice_channel_id) {
			const channel = await this.#fetchChannel(group.voice_channel_id);
			const name = voiceRaw.slice(0, 100);
			if (channel && name && channel.name !== name) {
				await channel.setName(name).catch(() => {});
				updates.push(`Vocal -> ${name}`);
			}
		}

		if (panelRaw && group.panel_channel_id) {
			const channel = await this.#fetchChannel(group.panel_channel_id);
			const name = this.#slugify(panelRaw) || null;
			if (channel && name && channel.name !== name) {
				await channel.setName(name).catch(() => {});
				updates.push(`Panel -> ${name}`);
			}
		}

		await this.ensurePanel(group).catch(() => {});

		if (!updates.length) {
			await this.#reply(interaction, 'Aucun changement.');
			return;
		}

		await this.#reply(interaction, `Salons mis a jour: ${updates.join(', ')}`);
	}

	async #applyMemberPermissions(group, member, role) {
		const category = await this.#fetchChannel(group.category_id);
		const textChannel = await this.#fetchChannel(group.text_channel_id);
		const voiceChannel = await this.#fetchChannel(group.voice_channel_id);
		const panelChannel = await this.#fetchChannel(group.panel_channel_id);

		if (category) {
			await category.permissionOverwrites.edit(member.id, { ViewChannel: true }).catch(() => {});
		}

		const isSpectator = role === 'spectator';
		if (textChannel) {
			await textChannel.permissionOverwrites
				.edit(member.id, {
					ViewChannel: true,
					ReadMessageHistory: true,
					SendMessages: !isSpectator
				})
				.catch(() => {});
		}

		if (voiceChannel) {
			await voiceChannel.permissionOverwrites
				.edit(member.id, {
					ViewChannel: true,
					Connect: true,
					Speak: !isSpectator
				})
				.catch(() => {});
		}

		if (panelChannel) {
			await panelChannel.permissionOverwrites
				.edit(member.id, { ViewChannel: false })
				.catch(() => {});
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
				await channel.permissionOverwrites.delete(memberId).catch(() => {});
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

	#slugify(value) {
		return String(value || '')
			.toLowerCase()
			.normalize('NFD')
			.replace(/\p{Diacritic}/gu, '')
			.replace(/[^a-z0-9\s-]/g, '')
			.trim()
			.replace(/\s+/g, '-')
			.slice(0, 32);
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
			await interaction.reply(payload);
		} else {
			await interaction.followUp(payload);
		}
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
