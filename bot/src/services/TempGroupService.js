const {
	ChannelType,
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	PermissionFlagsBits,
	MessageFlags
} = require('discord.js');
const { makeId, buildSlug, parseId } = require('../utils/ids');

class TempGroupService {
	constructor(client, db, logger = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
	}

	async createTempGroup(guild, { name, isOpen = true, participants = [], spectators = [] } = {}) {
		if (!guild) {
			throw new Error('guild is required');
		}

		const sanitizedName = typeof name === 'string' && name.trim().length ? name.trim().slice(0, 90) : 'Groupe temporaire';
		const slug = buildSlug(sanitizedName) || 'temp';
		const textName = `groupe-${slug}`.slice(0, 100);

		const botId = this.client.user?.id;
		if (!botId) {
			throw new Error('bot user unavailable');
		}

		const everyoneId = guild.roles.everyone.id;
		const memberIds = Array.from(new Set((participants || []).map((id) => String(id))));
		const spectatorIds = Array.from(
			new Set((spectators || []).map((id) => String(id)).filter((id) => !memberIds.includes(id)))
		);

		const categoryPermissionOverwrites = [
			{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
			{ id: botId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
			...memberIds.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel] })),
			...spectatorIds.map((id) => ({ id, allow: [PermissionFlagsBits.ViewChannel] }))
		];

		const category = await guild.channels.create({
			name: sanitizedName,
			type: ChannelType.GuildCategory,
			permissionOverwrites: categoryPermissionOverwrites,
			reason: 'Création groupe temporaire'
		});

		const textPermissionOverwrites = [
			{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel] },
			{
				id: botId,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.SendMessages,
					PermissionFlagsBits.ReadMessageHistory,
					PermissionFlagsBits.ManageChannels,
					PermissionFlagsBits.ManageMessages
				]
			},
			...memberIds.map((id) => ({
				id,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
			})),
			...spectatorIds.map((id) => ({
				id,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
				deny: [PermissionFlagsBits.SendMessages]
			}))
		];

		const textChannel = await guild.channels.create({
			name: textName,
			type: ChannelType.GuildText,
			parent: category.id,
			permissionOverwrites: textPermissionOverwrites,
			reason: 'Création groupe temporaire'
		});

		const voicePermissionOverwrites = [
			{ id: everyoneId, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
			{
				id: botId,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.Connect,
					PermissionFlagsBits.Speak,
					PermissionFlagsBits.MoveMembers,
					PermissionFlagsBits.ManageChannels
				]
			},
			...memberIds.map((id) => ({
				id,
				allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
			})),
			...spectatorIds.map((id) => ({
				id,
				allow: [PermissionFlagsBits.ViewChannel],
				deny: [PermissionFlagsBits.Connect]
			}))
		];

		const voiceChannel = await guild.channels.create({
			name: 'vocal',
			type: ChannelType.GuildVoice,
			parent: category.id,
			permissionOverwrites: voicePermissionOverwrites,
			reason: 'Création groupe temporaire'
		});

		const connection = await this.db.getConnection();
		let tempGroupId;
		try {
			await connection.beginTransaction();
			const [insertResult] = await connection.query(
				`INSERT INTO temp_groups
					(name, category_id, text_channel_id, voice_channel_id, archived, is_open, created_at, expires_at, last_activity_at)
				VALUES (?, ?, ?, ?, 0, ?, UTC_TIMESTAMP(), DATE_ADD(UTC_TIMESTAMP(), INTERVAL 72 HOUR), UTC_TIMESTAMP())`,
				[sanitizedName, category.id, textChannel.id, voiceChannel.id, isOpen ? 1 : 0]
			);
			tempGroupId = insertResult.insertId;

			const insertMemberSql = `INSERT INTO temp_group_members (temp_group_id, user_id, role)
				VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)`;
			for (const userId of memberIds) {
				await connection.query(insertMemberSql, [tempGroupId, userId, 'member']);
			}
			for (const userId of spectatorIds) {
				await connection.query(insertMemberSql, [tempGroupId, userId, 'spectator']);
			}

			await connection.commit();
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}

		const components = this.#buildPanelComponents({ id: tempGroupId, is_open: isOpen ? 1 : 0, frozen_until: null });
		const placeholderEmbed = new EmbedBuilder()
			.setTitle(sanitizedName)
			.setDescription('Initialisation du panel...')
			.setColor(0x5865f2);

		const panelMessage = await textChannel.send({ embeds: [placeholderEmbed], components });
		await panelMessage.pin().catch(() => {});

		await this.db.query('UPDATE temp_groups SET panel_message_id = ? WHERE id = ?', [panelMessage.id, tempGroupId]);

		try {
			await this.updatePanel(tempGroupId);
		} catch (error) {
			this.logger?.warn?.({ err: error, tempGroupId }, 'Impossible de mettre à jour le panel du groupe');
		}

		return {
			id: tempGroupId,
			categoryId: category.id,
			textChannelId: textChannel.id,
			voiceChannelId: voiceChannel.id,
			panelMessageId: panelMessage.id
		};
	}

	async updatePanel(tempGroupId) {
		const group = await this.#getGroup(tempGroupId);
		if (!group) return null;

		const textChannel = await this.#fetchChannel(group.text_channel_id);
		if (!textChannel) return null;

		const [memberRows] = await this.db.query(
			'SELECT user_id, role FROM temp_group_members WHERE temp_group_id = ? ORDER BY role, user_id',
			[tempGroupId]
		);
		const members = memberRows.filter((row) => row.role === 'member').map((row) => String(row.user_id));
		const spectators = memberRows.filter((row) => row.role === 'spectator').map((row) => String(row.user_id));

		const embed = this.#buildPanelEmbed(group, members, spectators);
		const components = this.#buildPanelComponents(group);

		let panelMessage = null;
		if (group.panel_message_id) {
			panelMessage = await textChannel.messages.fetch(group.panel_message_id).catch(() => null);
		}

		if (!panelMessage) {
			panelMessage = await textChannel.send({ embeds: [embed], components });
			await panelMessage.pin().catch(() => {});
			await this.db.query('UPDATE temp_groups SET panel_message_id = ? WHERE id = ?', [panelMessage.id, group.id]);
		} else {
			await panelMessage.edit({ embeds: [embed], components });
			if (!panelMessage.pinned) {
				await panelMessage.pin().catch(() => {});
			}
		}

		return panelMessage;
	}

	async setLastActivityByChannel(channelId) {
		if (!channelId) return false;
		const [rows] = await this.db.query('SELECT id FROM temp_groups WHERE text_channel_id = ?', [String(channelId)]);
		if (!rows.length) return false;
		const groupId = rows[0].id;
		await this.db.query('UPDATE temp_groups SET last_activity_at = UTC_TIMESTAMP() WHERE id = ?', [groupId]);
		try {
			await this.updatePanel(groupId);
		} catch (error) {
			this.logger?.warn?.({ err: error, tempGroupId: groupId }, 'Mise à jour du panel après activité échouée');
		}
		return true;
	}

	async addMembers(tempGroupId, userIds = []) {
		const group = await this.#getGroup(tempGroupId);
		if (!group) return;

		const ids = Array.from(new Set((userIds || []).map((id) => String(id))));
		if (!ids.length) return;

		const textChannel = await this.#fetchChannel(group.text_channel_id);
		const voiceChannel = await this.#fetchChannel(group.voice_channel_id);

		const sql = `INSERT INTO temp_group_members (temp_group_id, user_id, role)
			VALUES (?, ?, 'member') ON DUPLICATE KEY UPDATE role = VALUES(role)`;
		for (const userId of ids) {
			await this.db.query(sql, [tempGroupId, userId]);
			if (textChannel) {
				await textChannel.permissionOverwrites
					.edit(userId, {
						ViewChannel: true,
						SendMessages: true,
						ReadMessageHistory: true
					})
					.catch(() => {});
			}
			if (voiceChannel) {
				await voiceChannel.permissionOverwrites
					.edit(userId, {
						ViewChannel: true,
						Connect: true,
						Speak: true
					})
					.catch(() => {});
			}
		}

		await this.updatePanel(tempGroupId).catch((error) => {
			this.logger?.warn?.({ err: error, tempGroupId }, 'Impossible de rafraîchir le panel après ajout de membres');
		});
	}

	async addSpectators(tempGroupId, userIds = []) {
		const group = await this.#getGroup(tempGroupId);
		if (!group) return;

		const ids = Array.from(new Set((userIds || []).map((id) => String(id))));
		if (!ids.length) return;

		const textChannel = await this.#fetchChannel(group.text_channel_id);
		const voiceChannel = await this.#fetchChannel(group.voice_channel_id);

		const sql = `INSERT INTO temp_group_members (temp_group_id, user_id, role)
			VALUES (?, ?, 'spectator') ON DUPLICATE KEY UPDATE role = VALUES(role)`;
		for (const userId of ids) {
			await this.db.query(sql, [tempGroupId, userId]);
			if (textChannel) {
				await textChannel.permissionOverwrites
					.edit(userId, {
						ViewChannel: true,
						SendMessages: false,
						ReadMessageHistory: true
					})
					.catch(() => {});
			}
			if (voiceChannel) {
				await voiceChannel.permissionOverwrites
					.edit(userId, {
						ViewChannel: true,
						Connect: false,
						Speak: false
					})
					.catch(() => {});
			}
		}

		await this.updatePanel(tempGroupId).catch((error) => {
			this.logger?.warn?.({ err: error, tempGroupId }, 'Impossible de rafraîchir le panel après ajout de spectateurs');
		});
	}

	async removeUser(tempGroupId, userId) {
		const group = await this.#getGroup(tempGroupId);
		if (!group || !userId) return;
		const uid = String(userId);

		await this.db.query('DELETE FROM temp_group_members WHERE temp_group_id = ? AND user_id = ?', [tempGroupId, uid]);

		const textChannel = await this.#fetchChannel(group.text_channel_id);
		const voiceChannel = await this.#fetchChannel(group.voice_channel_id);

		if (textChannel) {
			await textChannel.permissionOverwrites.delete(uid).catch(() => {});
		}
		if (voiceChannel) {
			await voiceChannel.permissionOverwrites.delete(uid).catch(() => {});
		}

		await this.updatePanel(tempGroupId).catch((error) => {
			this.logger?.warn?.({ err: error, tempGroupId }, 'Impossible de rafraîchir le panel après retrait d’un membre');
		});
	}

	async handleArchiveButtons(interaction) {
		if (!interaction?.customId) return;
		const parsed = parseId(interaction.customId);
		if (!parsed || parsed.namespace !== 'temp') return;
		let action = parsed.parts?.[0] || '';
		let idPart = parsed.parts?.[1];
		if (action === 'panel') {
			action = parsed.parts?.[2] || '';
			idPart = parsed.parts?.[1];
		}
		const groupId = Number(idPart);
		if (!groupId) return;
		const group = await this.#getGroup(groupId);
		if (!group) {
			await interaction.reply({ content: 'Groupe introuvable.', flags: MessageFlags.Ephemeral }).catch(() => {});
			return;
		}
		const category = await this.#fetchChannel(group.category_id);
		if (!category) {
			await interaction.reply({ content: 'Catégorie introuvable.', flags: MessageFlags.Ephemeral }).catch(() => {});
			return;
		}
		const [memberRows] = await this.db.query('SELECT user_id FROM temp_group_members WHERE temp_group_id = ?', [groupId]);
		const members = new Set(Array.isArray(memberRows) ? memberRows.map((row) => String(row.user_id)) : []);
		const hasPermission = members.has(String(interaction.user?.id)) || interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
		if (!hasPermission) {
			await interaction.reply({ content: 'Seuls les membres du groupe (ou un modérateur) peuvent utiliser ces boutons.', flags: MessageFlags.Ephemeral }).catch(() => {});
			return;
		}
		if (action === 'delete') {
			await this.#deleteGroup(group);
			await interaction.reply({ content: 'Groupe supprimé.', flags: MessageFlags.Ephemeral }).catch(() => {});
			return;
		}
		if (action === 'extend') {
			await this.db.query('UPDATE temp_groups SET expires_at = DATE_ADD(UTC_TIMESTAMP(), INTERVAL 72 HOUR) WHERE id = ?', [groupId]);
			await this.updatePanel(groupId).catch(() => {});
			await interaction.reply({ content: 'Groupe prolongé de 72h.', flags: MessageFlags.Ephemeral }).catch(() => {});
			return;
		}
		if (action === 'refresh') {
			await this.updatePanel(groupId);
			await interaction.reply({ content: 'Panel mis à jour.', flags: MessageFlags.Ephemeral }).catch(() => {});
			return;
		}
		if (action === 'invite') {
			const textChannel = await this.#fetchChannel(group.text_channel_id);
			if (!textChannel?.createInvite) {
				await interaction.reply({ content: 'Impossible de créer une invitation pour ce groupe.', flags: MessageFlags.Ephemeral }).catch(() => {});
				return;
			}
			const invite = await textChannel.createInvite({ maxAge: 3600, maxUses: 1, reason: 'Invitation groupe temporaire' }).catch(() => null);
			if (!invite) {
				await interaction.reply({ content: 'La création de l\'invitation a échoué.', flags: MessageFlags.Ephemeral }).catch(() => {});
				return;
			}
			await interaction.reply({ content: `Invitation créée : ${invite.url}`, flags: MessageFlags.Ephemeral }).catch(() => {});
		}
	}

	async sweepExpired() {
		const [rows] = await this.db.query('SELECT * FROM temp_groups WHERE archived = 0 AND expires_at <= UTC_TIMESTAMP()');
		for (const group of rows) {
			const textChannel = await this.#fetchChannel(group.text_channel_id);
			const voiceChannel = await this.#fetchChannel(group.voice_channel_id);
			const guild = textChannel?.guild || voiceChannel?.guild || null;
			const everyoneId = guild?.roles?.everyone?.id || null;
			if (textChannel && everyoneId) {
				await textChannel.permissionOverwrites.edit(everyoneId, { SendMessages: false }).catch(() => {});
			}
			if (voiceChannel && everyoneId) {
				await voiceChannel.permissionOverwrites.edit(everyoneId, { Connect: false }).catch(() => {});
			}
			await this.db.query('UPDATE temp_groups SET archived = 1, is_open = 0 WHERE id = ?', [group.id]);
			try {
				await this.updatePanel(group.id);
			} catch (error) {
				this.logger?.warn?.({ err: error, tempGroupId: group.id }, 'Mise à jour du panel après archivage échouée');
			}
		}
	}

	async #deleteGroup(group) {
		if (!group) return;
		const textChannel = await this.#fetchChannel(group.text_channel_id);
		const voiceChannel = await this.#fetchChannel(group.voice_channel_id);
		const category = await this.#fetchChannel(group.category_id);
		if (textChannel) {
			await textChannel.delete().catch(() => {});
		}
		if (voiceChannel) {
			await voiceChannel.delete().catch(() => {});
		}
		if (category) {
			await category.delete().catch(() => {});
		}
		await this.db.query('DELETE FROM temp_group_members WHERE temp_group_id = ?', [group.id]);
		await this.db.query('DELETE FROM temp_groups WHERE id = ?', [group.id]);
	}


	#buildPanelEmbed(group, members, spectators) {
		const totalMembers = members.length;
		const totalSpectators = spectators.length;
		const now = Date.now();
		const frozenUntil = group.frozen_until ? new Date(group.frozen_until) : null;
		const isFrozen = frozenUntil && frozenUntil.getTime() > now;
		const isOpen = Boolean(group.is_open);

		const formatter = new Intl.DateTimeFormat('fr-FR', {
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			timeZone: 'Europe/Paris'
		});

		let status = isOpen ? 'Ouvert' : 'Fermé';
		if (isFrozen) {
			status = `Gelé jusqu’au ${formatter.format(frozenUntil)}`;
		}

		const lastActivity = group.last_activity_at ? formatter.format(new Date(group.last_activity_at)) : 'Aucune donnée';

		const embed = new EmbedBuilder()
			.setTitle(group.name)
			.setColor(isFrozen ? 0xf1c40f : isOpen ? 0x57f287 : 0xed4245)
			.setDescription(`Statut : ${status}
Dernière activité : ${lastActivity}`)
			.addFields(
				{
					name: `Membres (${totalMembers})`,
					value: totalMembers ? members.map((id) => `<@${id}>`).join(', ') : 'Aucun membre'
				},
				{
					name: `Spectateurs (${totalSpectators})`,
					value: totalSpectators ? spectators.map((id) => `<@${id}>`).join(', ') : 'Aucun spectateur'
				}
			);

		return embed;
	}

	#buildPanelComponents(group) {
		const frozenUntil = group.frozen_until ? new Date(group.frozen_until) : null;
		const isFrozen = frozenUntil && frozenUntil.getTime() > Date.now();
		const isOpen = Boolean(group.is_open) && !isFrozen;

		const refreshButton = new ButtonBuilder()
			.setCustomId(makeId('temp:panel', group.id, 'refresh'))
			.setLabel('Actualiser')
			.setStyle(ButtonStyle.Secondary);

		const inviteButton = new ButtonBuilder()
			.setCustomId(makeId('temp:panel', group.id, 'invite'))
			.setLabel('Inviter')
			.setStyle(ButtonStyle.Primary);

		const joinButton = new ButtonBuilder()
			.setCustomId(makeId('temp:join', group.id))
			.setLabel('Rejoindre')
			.setStyle(ButtonStyle.Success)
			.setDisabled(!isOpen);

		const spectateButton = new ButtonBuilder()
			.setCustomId(makeId('temp:spectate', group.id))
			.setLabel('Observer')
			.setStyle(ButtonStyle.Secondary)
			.setDisabled(!isOpen);

		const leaveButton = new ButtonBuilder()
			.setCustomId(makeId('temp:leave', group.id))
			.setLabel('Quitter')
			.setStyle(ButtonStyle.Danger);

		return [
			new ActionRowBuilder().addComponents(refreshButton, inviteButton),
			new ActionRowBuilder().addComponents(joinButton, spectateButton, leaveButton)
		];
	}

	async #getGroup(tempGroupId) {
		if (!tempGroupId) return null;
		const [rows] = await this.db.query('SELECT * FROM temp_groups WHERE id = ?', [tempGroupId]);
		return rows?.[0] || null;
	}

	async #fetchChannel(channelId) {
		if (!channelId) return null;
		return this.client.channels.fetch(channelId).catch(() => null);
	}
}

module.exports = { TempGroupService };
