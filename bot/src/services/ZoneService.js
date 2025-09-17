const {
	ChannelType,
	PermissionFlagsBits,
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle
} = require('discord.js');

const { buildSlug, randomCode } = require('../utils/ids');
const { applyZonePermissions } = require('../utils/permissions');
const { withTransaction } = require('../utils/db');

const ALLOWED_POLICIES = new Set(['closed', 'ask', 'invite', 'open']);

class ZoneService {
	constructor(client, pool, logger) {
		this.client = client;
		this.pool = pool;
		this.logger = logger;
		this.ownerUserId = process.env.OWNER_USER_ID;
	}

	async createZone(guild, { name, ownerId, policy }) {
		if (!ALLOWED_POLICIES.has(policy)) {
			throw new Error('Politique invalide');
		}
		const slugBase = buildSlug(name) || `zone-${randomCode(4).toLowerCase()}`;
		let slug = slugBase;
		let iteration = 1;
		while (await this.getZoneBySlug(guild.id, slug)) {
			slug = `${slugBase}-${++iteration}`;
		}

		const createdRoles = [];
		const createdChannels = [];

		try {
			const ownerRole = await guild.roles.create({
				name: `ZoneOwner-${slug}`,
				mentionable: false,
				permissions: [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.MuteMembers]
			});
			const memberRole = await guild.roles.create({
				name: `ZoneMember-${slug}`,
				mentionable: false,
				permissions: []
			});
			const mutedRole = await guild.roles.create({
				name: `ZoneMuted-${slug}`,
				mentionable: false,
				permissions: []
			});
			createdRoles.push(ownerRole, memberRole, mutedRole);

			const category = await guild.channels.create({
				name: `zone-${slug}`,
				type: ChannelType.GuildCategory
			});
			const panel = await guild.channels.create({ name: 'panel', type: ChannelType.GuildText, parent: category });
			const reception = await guild.channels.create({ name: 'reception', type: ChannelType.GuildText, parent: category });
			const general = await guild.channels.create({ name: 'general', type: ChannelType.GuildText, parent: category });
			const anonAgora = await guild.channels.create({ name: 'anon-agora', type: ChannelType.GuildText, parent: category });
			const voice = await guild.channels.create({ name: 'vocal', type: ChannelType.GuildVoice, parent: category });
			createdChannels.push(category, panel, reception, general, anonAgora, voice);

			await applyZonePermissions(category, {
				everyoneRoleId: guild.roles.everyone.id,
				ownerRoleId: ownerRole.id,
				memberRoleId: memberRole.id,
				mutedRoleId: mutedRole.id,
				ownerUserId: this.ownerUserId || guild.ownerId
			});

			const ownerMember = await guild.members.fetch(ownerId);
			await ownerMember.roles.add([ownerRole.id, memberRole.id]);

			const webhook = await anonAgora.createWebhook({ name: `anon-${slug}` });

			const insertResult = await withTransaction(async (conn) => {
				const [zoneInsert] = await conn.query(
					`INSERT INTO zones
					(guild_id, name, slug, owner_user_id, category_id, text_panel_id, text_reception_id, text_general_id, text_anon_id, voice_id, role_owner_id, role_member_id, role_muted_id, policy)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					[
						guild.id,
						name,
						slug,
						ownerId,
						category.id,
						panel.id,
						reception.id,
						general.id,
						anonAgora.id,
						voice.id,
						ownerRole.id,
						memberRole.id,
						mutedRole.id,
						policy
					]
				);
				const zoneId = zoneInsert.insertId;
				await conn.query('INSERT INTO zone_members (zone_id, user_id, role) VALUES (?, ?, ?)', [zoneId, ownerId, 'owner']);
				await conn.query('INSERT INTO anon_channels (zone_id, source_channel_id, webhook_id, webhook_token) VALUES (?, ?, ?, ?)', [zoneId, anonAgora.id, webhook.id, webhook.token]);
				return zoneId;
			});

			await panel.send({
				content: `<@${ownerId}>`,
				embeds: [
					new EmbedBuilder()
					.setTitle('Zone prête à l'emploi')
					.setDescription('Utilisez `/zone policy set` pour ajuster la politique et `/zone member add` pour inviter vos membres. Les actions sensibles restent anonymes.')
				]
			});

			return {
				id: insertResult,
				guildId: guild.id,
				name,
				slug,
				ownerId,
				categoryId: category.id,
				panelId: panel.id,
				receptionId: reception.id,
				generalId: general.id,
				anonId: anonAgora.id,
				voiceId: voice.id,
				ownerRoleId: ownerRole.id,
				memberRoleId: memberRole.id,
				mutedRoleId: mutedRole.id,
				policy
			};
		} catch (error) {
			this.logger.error({ err: error }, 'Zone creation failure, rolling back');
			for (const channel of createdChannels.reverse()) {
				channel?.deletable && channel.delete('Zone creation rollback').catch(() => undefined);
			}
			for (const role of createdRoles.reverse()) {
				role?.editable && role.delete('Zone creation rollback').catch(() => undefined);
			}
			throw error;
		}
	}

	async getZoneBySlug(guildId, slug) {
		const [rows] = await this.pool.query('SELECT * FROM zones WHERE guild_id = ? AND slug = ?', [guildId, slug]);
		return rows[0] || null;
	}

	async getZoneById(zoneId) {
		const [rows] = await this.pool.query('SELECT * FROM zones WHERE id = ?', [zoneId]);
		return rows[0] || null;
	}

	async getZoneByChannelId(channelId) {
		const [rows] = await this.pool.query(
			'SELECT * FROM zones WHERE text_panel_id = ? OR text_reception_id = ? OR text_general_id = ? OR text_anon_id = ? OR voice_id = ?',
			[channelId, channelId, channelId, channelId, channelId]
		);
		return rows[0] || null;
	}

	async listZones(guildId) {
		const [rows] = await this.pool.query('SELECT * FROM zones WHERE guild_id = ?', [guildId]);
		return rows;
	}

	async ensureZoneOwner(zoneId, userId) {
		const zone = await this.getZoneById(zoneId);
		if (!zone) {
			throw new Error('Zone introuvable');
		}
		if (userId === this.ownerUserId) {
			return zone;
		}
		const [rows] = await this.pool.query('SELECT role FROM zone_members WHERE zone_id = ? AND user_id = ?', [zoneId, userId]);
		if (!rows[0] || rows[0].role !== 'owner') {
			throw new Error('Action réservée au propriétaire de la zone.');
		}
		return zone;
	}

	async ensureZoneMember(zoneId, userId) {
		const zone = await this.getZoneById(zoneId);
		if (!zone) {
			throw new Error('Zone introuvable');
		}
		if (userId === this.ownerUserId) {
			return zone;
		}
		const [rows] = await this.pool.query('SELECT role FROM zone_members WHERE zone_id = ? AND user_id = ?', [zoneId, userId]);
		if (!rows[0]) {
			throw new Error('Vous n'appartenez pas à cette zone.');
		}
		return zone;
	}

	async addMember(zoneId, userId) {
		const zone = await this.getZoneById(zoneId);
		if (!zone) {
			throw new Error('Zone introuvable');
		}
		const guild = await this.client.guilds.fetch(zone.guild_id);
		const member = await guild.members.fetch(userId);
		await member.roles.add(zone.role_member_id);
		await this.pool.query('REPLACE INTO zone_members (zone_id, user_id, role) VALUES (?, ?, ?)', [zoneId, userId, zone.owner_user_id === userId ? 'owner' : 'member']);
		return member;
	}

	async removeMember(zoneId, userId) {
		const zone = await this.getZoneById(zoneId);
		if (!zone) {
			throw new Error('Zone introuvable');
		}
		const guild = await this.client.guilds.fetch(zone.guild_id);
		const member = await guild.members.fetch(userId);
		await member.roles.remove([zone.role_member_id, zone.role_owner_id]);
		await this.pool.query('DELETE FROM zone_members WHERE zone_id = ? AND user_id = ?', [zoneId, userId]);
		return member;
	}

	async createRole(zoneId, name) {
		const zone = await this.getZoneById(zoneId);
		if (!zone) {
			throw new Error('Zone introuvable');
		}
		const guild = await this.client.guilds.fetch(zone.guild_id);
		const role = await guild.roles.create({ name, permissions: [] });
		const category = guild.channels.cache.get(zone.category_id);
		if (category) {
			await category.permissionOverwrites.create(role, {
				ViewChannel: true,
				SendMessages: true,
				Connect: true,
				Speak: true
			});
			for (const channel of category.children.cache.values()) {
				await channel.permissionOverwrites.create(role, {
					ViewChannel: true,
					SendMessages: channel.isTextBased(),
					Connect: channel.type === ChannelType.GuildVoice,
					Speak: channel.type === ChannelType.GuildVoice
				});
			}
		}
		return role;
	}

	async renameRole(zoneId, roleId, newName) {
		const zone = await this.getZoneById(zoneId);
		const guild = await this.client.guilds.fetch(zone.guild_id);
		const role = await guild.roles.fetch(roleId);
		if (!role) {
			throw new Error('Rôle introuvable');
		}
		await role.setName(newName);
		return role;
	}

	async deleteRole(zoneId, roleId) {
		const zone = await this.getZoneById(zoneId);
		const guild = await this.client.guilds.fetch(zone.guild_id);
		const role = await guild.roles.fetch(roleId);
		if (!role) {
			throw new Error('Rôle introuvable');
		}
		await role.delete('Zone cleanup');
	}

	async createChannel(zoneId, type, name) {
		const zone = await this.getZoneById(zoneId);
		if (!zone) {
			throw new Error('Zone introuvable');
		}
		const guild = await this.client.guilds.fetch(zone.guild_id);
		const category = guild.channels.cache.get(zone.category_id);
		if (!category) {
			throw new Error('Catégorie manquante');
		}
		const channelType = type === 'voice' ? ChannelType.GuildVoice : ChannelType.GuildText;
		const channel = await guild.channels.create({ name, type: channelType, parent: category });
		await applyZonePermissions(category, {
			everyoneRoleId: guild.roles.everyone.id,
			ownerRoleId: zone.role_owner_id,
			memberRoleId: zone.role_member_id,
			mutedRoleId: zone.role_muted_id,
			ownerUserId: this.ownerUserId || guild.ownerId
		});
		return channel;
	}

	async renameChannel(channelId, newName) {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel) {
			throw new Error('Canal introuvable');
		}
		await channel.setName(newName);
		return channel;
	}

	async deleteChannel(channelId) {
		const channel = await this.client.channels.fetch(channelId);
		if (!channel) {
			throw new Error('Canal introuvable');
		}
		await channel.delete('Zone operation');
	}

	async generateJoinCode(zoneId, userId, ttlMinutes) {
		if (Number.isNaN(ttlMinutes) || ttlMinutes <= 0) {
			throw new Error('Durée invalide');
		}
		const code = randomCode(12);
		const expiresAt = new Date(Date.now() + ttlMinutes * 60000);
		await this.pool.query('INSERT INTO join_codes (zone_id, issued_to_user_id, code, expires_at, used) VALUES (?, ?, ?, ?, ?)', [zoneId, userId, code, expiresAt, false]);
		return { code, expiresAt };
	}

	async getSettings(guildId) {
		const [rows] = await this.pool.query('SELECT * FROM settings WHERE guild_id = ?', [guildId]);
		if (rows.length) {
			return rows[0];
		}
		await this.pool.query('INSERT IGNORE INTO settings (guild_id) VALUES (?)', [guildId]);
		const [fresh] = await this.pool.query('SELECT * FROM settings WHERE guild_id = ?', [guildId]);
		return fresh[0];
	}

	async handleRequestModal(interaction) {
		const guildId = interaction.guild.id;
		const name = interaction.fields.getTextInputValue('zone-name').slice(0, 100);
		const description = interaction.fields.getTextInputValue('zone-description').slice(0, 1024);
		const policy = interaction.fields.getTextInputValue('zone-policy').toLowerCase();
		if (!ALLOWED_POLICIES.has(policy)) {
			await interaction.reply({ content: 'Politique invalide. Merci de respecter closed/ask/invite/open.', ephemeral: true });
			return;
		}
		const settings = await this.getSettings(guildId);
		if (!settings?.requests_channel_id) {
			await interaction.reply({ content: 'Aucun canal de gestion configuré. Prévenez l'administrateur.', ephemeral: true });
			return;
		}
		const requestChannel = await this.client.channels.fetch(settings.requests_channel_id);
		const embed = new EmbedBuilder()
		.setTitle('Nouvelle demande de zone')
		.setDescription(description)
		.addFields(
			{ name: 'Demandeur', value: `<@${interaction.user.id}>`, inline: true },
			{ name: 'Nom', value: name, inline: true },
			{ name: 'Politique souhaitée', value: policy, inline: true }
		)
		.setTimestamp();
		await requestChannel.send({
			embeds: [embed],
			components: [
				new ActionRowBuilder().addComponents(
					new ButtonBuilder().setCustomId(`zone.approve:${interaction.user.id}`).setLabel('Approuver').setStyle(ButtonStyle.Success),
					new ButtonBuilder().setCustomId(`zone.reject:${interaction.user.id}`).setLabel('Refuser').setStyle(ButtonStyle.Danger)
				)
			]
		});
		await interaction.reply({ content: 'Votre demande a été transmise. Merci !', ephemeral: true });
	}

	buildRequestModal() {
		const modal = new ModalBuilder().setCustomId('zoneRequest:create').setTitle('Demander une zone');
		modal.addComponents(
			new ActionRowBuilder().addComponents(
				new TextInputBuilder()
				.setCustomId('zone-name')
				.setLabel('Nom de la zone')
				.setPlaceholder('Nom court et unique')
				.setMaxLength(100)
				.setStyle(TextInputStyle.Short)
				.setRequired(true)
			),
			new ActionRowBuilder().addComponents(
				new TextInputBuilder()
				.setCustomId('zone-description')
				.setLabel('Description')
				.setStyle(TextInputStyle.Paragraph)
				.setRequired(true)
			),
			new ActionRowBuilder().addComponents(
				new TextInputBuilder()
				.setCustomId('zone-policy')
				.setLabel('Politique (closed/ask/invite/open)')
				.setStyle(TextInputStyle.Short)
				.setRequired(true)
			)
		);
		return modal;
	}
}

module.exports = ZoneService;