const { ChannelType, EmbedBuilder, MessageFlags } = require('discord.js');
const { applyZoneOverwrites } = require('../utils/permissions');

class ZoneService {
        constructor(client, db, ownerId, logger, panelService = null) {
                this.client = client;
                this.db = db;
                this.ownerId = ownerId;
                this.logger = logger;
                this.panelService = panelService;
        }

        setPanelService(panelService) {
                this.panelService = panelService;
        }

	#slugify(name) {
		return String(name).toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9\-]/g, '').slice(0, 32);
	}

	async handleZoneRequestModal(interaction) {
                await interaction.reply({ content: 'Reçu. Ta demande a été transmise à l’Owner.', flags: MessageFlags.Ephemeral });
		// TODO: post into #zone-requests
	}

	async createZone(guild, { name, ownerUserId, policy }) {
		const slug = this.#slugify(name);

		// Roles
                const roleOwner = await guild.roles.create({ name: `O-${slug}`, mentionable: false, permissions: [] });
                const roleMember = await guild.roles.create({ name: `M-${slug}`, mentionable: false, permissions: [] });
                // Category + channels
                const category = await guild.channels.create({ name: `z-${slug}`, type: ChannelType.GuildCategory });
                const panel = await guild.channels.create({ name: 'panel', type: ChannelType.GuildText, parent: category.id });
                const reception = await guild.channels.create({ name: 'reception', type: ChannelType.GuildText, parent: category.id });
                const anon = await guild.channels.create({ name: 'chuchotement', type: ChannelType.GuildText, parent: category.id });
                const general = await guild.channels.create({ name: 'general', type: ChannelType.GuildText, parent: category.id });
                const voice = await guild.channels.create({ name: 'vocal', type: ChannelType.GuildVoice, parent: category.id });

                // Overwrites
                const botMember = guild.members.me || await guild.members.fetch(this.client.user.id).catch(() => null);
                const botRole = botMember?.roles?.highest || null;
                await applyZoneOverwrites(
                        category,
                        {
                                everyoneRole: guild.roles.everyone,
                                zoneMemberRole: roleMember,
                                zoneOwnerRole: roleOwner
                        },
                        botRole,
                        { panel, reception, general, chuchotement: anon, voice }
                );

		// Persist
		const [res] = await this.db.query(
			`INSERT INTO zones (guild_id, name, slug, owner_user_id, category_id, text_panel_id, text_reception_id,
                        text_general_id, text_anon_id, voice_id, role_owner_id, role_member_id, role_muted_id, policy, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
			[
				guild.id,
				name,
				slug,
				ownerUserId,
				category.id,
				panel.id,
				reception.id,
				general.id,
                                anon.id,
                                voice.id,
                                roleOwner.id,
                                roleMember.id,
                                null,
				policy
			]
		);
		const zoneId = res.insertId;

		await this.db.query(
                        `INSERT INTO anon_channels (zone_id, source_channel_id, webhook_id, webhook_token) VALUES (?, ?, ?, ?)`,
                        [zoneId, anon.id, null, null]
                );

		// Grant roles
		const member = await guild.members.fetch(ownerUserId).catch(() => null);
		if (member) await member.roles.add([roleOwner, roleMember]).catch(() => {});

		// Panel
                const embed = new EmbedBuilder()
                        .setTitle(`Panneau de la zone ${name}`)
                        .setDescription('Configure la politique, gère les membres, rôles et salons via le bot.')
                        .addFields(
                                { name: 'Politique', value: policy, inline: true },
                                { name: 'Owner', value: `<@${ownerUserId}>`, inline: true }
                        )
                        .setTimestamp();
                await panel.send({ content: `<@${ownerUserId}>`, embeds: [embed] }).catch(() => {});

                if (this.panelService) {
                        await this.panelService.renderInitialPanel({
                                guild,
                                zone: {
                                        id: zoneId,
                                        name,
                                        slug,
                                        policy,
                                        ownerUserId,
                                        roleOwnerId: roleOwner.id,
                                        roleMemberId: roleMember.id,
                                        categoryId: category.id,
                                        panelChannelId: panel.id,
                                        receptionChannelId: reception.id,
                                        generalChannelId: general.id,
                                        chuchotementChannelId: anon.id,
                                        voiceChannelId: voice.id
                                },
                                roles: { owner: roleOwner, member: roleMember },
                                channels: { panel, reception, general, chuchotement: anon, voice, category }
                        }).catch((err) => {
                                this.logger?.warn({ err, zoneId }, 'Failed to render full panel');
                        });
                }

                return { zoneId, slug };
        }

	async listZones(guildId) {
		const [rows] = await this.db.query(
			`SELECT id, name, slug, owner_user_id, policy, created_at
			 FROM zones
			 WHERE guild_id = ?
			 ORDER BY created_at DESC, id DESC`,
			[guildId]
		);
		return rows;
	}

	async #safeDeleteChannel(guild, channelId, reason) {
		if (!channelId) return;
		const channel = await guild.channels.fetch(channelId).catch(() => null);
		if (!channel) return;
		await channel.delete(reason).catch((err) => {
			this.logger?.warn({ err, channelId }, 'Failed to delete zone channel');
		});
	}

	async #safeDeleteRole(guild, roleId, reason) {
		if (!roleId) return;
		const role = await guild.roles.fetch(roleId).catch(() => null);
		if (!role) return;
		await role.delete(reason).catch((err) => {
			this.logger?.warn({ err, roleId }, 'Failed to delete zone role');
		});
	}

	async #deleteZoneRecords(zoneId) {
		const queries = [
			['DELETE FROM anon_channels WHERE zone_id = ?', [zoneId]],
			['DELETE FROM zone_members WHERE zone_id = ?', [zoneId]],
			['DELETE FROM join_codes WHERE zone_id = ?', [zoneId]],
			['DELETE FROM join_requests WHERE zone_id = ?', [zoneId]],
			['DELETE FROM zone_activity WHERE zone_id = ?', [zoneId]],
			['DELETE FROM event_participants WHERE zone_id = ?', [zoneId]],
			['DELETE FROM anon_logs WHERE source_zone_id = ?', [zoneId]]
		];

		for (const [sql, params] of queries) {
			await this.db.query(sql, params);
		}

		await this.db.query('DELETE FROM zones WHERE id = ?', [zoneId]);
	}

	async deleteZone(guild, zoneId) {
		const [rows] = await this.db.query('SELECT * FROM zones WHERE id = ? AND guild_id = ?', [zoneId, guild.id]);
		const zone = rows?.[0];
		if (!zone) {
			return { success: false, reason: 'Zone introuvable.' };
		}

		const reason = `Zone #${zoneId} deletion requested by owner.`;

		await this.#safeDeleteChannel(guild, zone.category_id, reason);
		await this.#safeDeleteChannel(guild, zone.text_panel_id, reason);
		await this.#safeDeleteChannel(guild, zone.text_reception_id, reason);
		await this.#safeDeleteChannel(guild, zone.text_general_id, reason);
		await this.#safeDeleteChannel(guild, zone.text_anon_id, reason);
		await this.#safeDeleteChannel(guild, zone.voice_id, reason);

                await this.#safeDeleteRole(guild, zone.role_owner_id, reason);
                await this.#safeDeleteRole(guild, zone.role_member_id, reason);

		await this.#deleteZoneRecords(zoneId);

		this.logger?.info({ zoneId }, 'Zone deleted');

		return { success: true, zone };
	}

	async cleanupOrphans() {
		const [rows] = await this.db.query('SELECT id, guild_id, category_id FROM zones');
		for (const zone of rows) {
			const guild = await this.client.guilds.fetch(zone.guild_id).catch(() => null);
			if (!guild) {
				await this.#deleteZoneRecords(zone.id);
				this.logger?.warn({ zoneId: zone.id, guildId: zone.guild_id }, 'Cleaned zone for missing guild');
				continue;
			}

			const category = await guild.channels.fetch(zone.category_id).catch(() => null);
			if (!category) {
				const res = await this.deleteZone(guild, zone.id);
				if (!res.success) {
					await this.#deleteZoneRecords(zone.id);
				}
				this.logger?.warn({ zoneId: zone.id }, 'Cleaned orphan zone (missing category)');
			}
		}
	}
}

module.exports = { ZoneService };
