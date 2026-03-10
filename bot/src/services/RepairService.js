const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { detectChannel, detectRole, detectMessage } = require('./repair/detect');
const {
	restoreZoneCategory,
	restoreZoneChannel,
	restoreZoneRole,
	restoreZoneCustomRole,
	clearSettingsChannel
} = require('./repair/restore');

// Human-readable labels for settings columns
const SETTINGS_LABELS = {
	anon_admin_channel_id:  'Logs anonymes',
	requests_channel_id:    'Demandes de zones',
	events_admin_channel_id: 'Tableau des événements',
	journal_channel_id:     'Journal du serveur'
};

// Human-readable labels for zone channel fields
const ZONE_CHANNEL_LABELS = {
	text_panel_id:     'panel',
	text_reception_id: 'reception',
	text_general_id:   'general',
	text_anon_id:      'chuchotement',
	voice_id:          'vocal (voix)'
};

// Human-readable labels for zone role fields
const ZONE_ROLE_LABELS = {
	role_owner_id:  'rôle propriétaire',
	role_member_id: 'rôle membre',
	role_muted_id:  'rôle muet'
};

// Suppression TTL in ms — resources registered before a bot-initiated delete
const SUPPRESS_TTL = 30_000;

class RepairService {
	/** @type {Map<string, ReturnType<typeof setTimeout>>} */
	#suppressedChannels = new Map();
	/** @type {Map<string, ReturnType<typeof setTimeout>>} */
	#suppressedRoles = new Map();
	/** @type {Map<string, ReturnType<typeof setTimeout>>} */
	#suppressedMessages = new Map();

	constructor(client, db, logger) {
		this.client = client;
		this.db = db;
		this.logger = logger;
	}

	// ─── Suppression API (called before intentional bot deletions) ────────────

	suppressChannel(id) {
		if (!id) return;
		clearTimeout(this.#suppressedChannels.get(id));
		this.#suppressedChannels.set(id, setTimeout(() => this.#suppressedChannels.delete(id), SUPPRESS_TTL));
	}

	suppressRole(id) {
		if (!id) return;
		clearTimeout(this.#suppressedRoles.get(id));
		this.#suppressedRoles.set(id, setTimeout(() => this.#suppressedRoles.delete(id), SUPPRESS_TTL));
	}

	suppressMessage(id) {
		if (!id) return;
		clearTimeout(this.#suppressedMessages.get(id));
		this.#suppressedMessages.set(id, setTimeout(() => this.#suppressedMessages.delete(id), SUPPRESS_TTL));
	}

	// ─── Discord event handlers ───────────────────────────────────────────────

	async handleChannelDelete(channel) {
		if (!channel?.id) return;

		if (this.#suppressedChannels.has(channel.id)) {
			clearTimeout(this.#suppressedChannels.get(channel.id));
			this.#suppressedChannels.delete(channel.id);
			return;
		}

		try {
			const detected = await detectChannel(this.db, channel.id);
			if (!detected) return;
			await this.#sendAlert(detected);
		} catch (err) {
			this.logger?.warn({ err, channelId: channel.id }, 'RepairService: handleChannelDelete failed');
		}
	}

	async handleRoleDelete(role) {
		if (!role?.id) return;

		if (this.#suppressedRoles.has(role.id)) {
			clearTimeout(this.#suppressedRoles.get(role.id));
			this.#suppressedRoles.delete(role.id);
			return;
		}

		try {
			const detected = await detectRole(this.db, role.id);
			if (!detected) return;
			await this.#sendAlert(detected);
		} catch (err) {
			this.logger?.warn({ err, roleId: role.id }, 'RepairService: handleRoleDelete failed');
		}
	}

	async handleMessageDelete(message) {
		if (!message?.id) return;

		if (this.#suppressedMessages.has(message.id)) {
			clearTimeout(this.#suppressedMessages.get(message.id));
			this.#suppressedMessages.delete(message.id);
			return;
		}

		try {
			const detected = await detectMessage(this.db, message.id);
			if (!detected) return;
			await this.#sendAlert(detected);
		} catch (err) {
			this.logger?.warn({ err, messageId: message.id }, 'RepairService: handleMessageDelete failed');
		}
	}

	// ─── Button handler ───────────────────────────────────────────────────────

	async handleButton(interaction) {
		const id = interaction.customId;

		if (id.startsWith('repair:confirm:')) {
			return this.#handleRepairConfirm(interaction);
		}

		if (id === 'repair:ignore') {
			await interaction.update({ components: [] });
			return true;
		}

		if (id === 'repair:scan:all') {
			return this.#handleRepairAll(interaction);
		}

		return false;
	}

	// ─── Manual scan (/repair command) ───────────────────────────────────────

	/**
	 * Scans all bot-managed resources for a guild and returns a report.
	 * Returns { issues: [], embed } — issues have the same shape as detect results.
	 */
	async scanGuild(guildId) {
		const issues = [];

		// Fetch the guild from Discord
		const guild = await this.client.guilds.fetch(guildId).catch(() => null);
		if (!guild) return { issues, guild: null };

		// ── Zone channels & roles ────────────────────────────────────────────
		const [zones] = await this.db.query(
			`SELECT id, guild_id, name, slug, category_id,
			        text_panel_id, text_reception_id, text_general_id, text_anon_id, voice_id,
			        role_owner_id, role_member_id, role_muted_id
			 FROM zones WHERE guild_id = ?`,
			[guildId]
		);

		for (const zone of zones) {
			// Check each channel field
			const channelFields = ['category_id', 'text_panel_id', 'text_reception_id', 'text_general_id', 'text_anon_id', 'voice_id'];
			for (const field of channelFields) {
				const chId = zone[field];
				if (!chId) continue;
				const ch = await guild.channels.fetch(chId).catch(() => null);
				if (!ch) {
					issues.push({
						type: field === 'category_id' ? 'zone_category' : 'zone_channel',
						field, zoneId: zone.id, guildId, zone
					});
				}
			}

			// Check each role field
			const roleFields = ['role_owner_id', 'role_member_id', 'role_muted_id'];
			for (const field of roleFields) {
				const rId = zone[field];
				if (!rId) continue;
				const r = await guild.roles.fetch(rId).catch(() => null);
				if (!r) {
					issues.push({
						type: 'zone_role',
						field, zoneId: zone.id, guildId, zone, roleId: rId
					});
				}
			}
		}

		// ── Settings channels ────────────────────────────────────────────────
		const [settingsRows] = await this.db.query(
			'SELECT * FROM settings WHERE guild_id = ?',
			[guildId]
		);
		const settings = settingsRows[0];
		if (settings) {
			const cols = ['anon_admin_channel_id', 'requests_channel_id', 'events_admin_channel_id', 'journal_channel_id'];
			for (const col of cols) {
				const chId = settings[col];
				if (!chId) continue;
				const ch = await guild.channels.fetch(chId).catch(() => null);
				if (!ch) {
					issues.push({ type: 'settings_channel', column: col, guildId });
				}
			}
		}

		return { issues, guild };
	}

	// ─── Private: alert builder ───────────────────────────────────────────────

	async #sendAlert(detected) {
		const { guildId } = detected;
		const guild = await this.client.guilds.fetch(guildId).catch(() => null);
		if (!guild) return;

		const { title, description, canRepair, confirmId } = this.#buildAlertContent(detected);

		const embed = new EmbedBuilder()
			.setTitle('⚠️ Ressource supprimée détectée')
			.setColor(0xed4245)
			.addFields({ name: title, value: description });

		const row = new ActionRowBuilder();

		if (canRepair) {
			row.addComponents(
				new ButtonBuilder()
					.setCustomId(confirmId)
					.setLabel('🔧 Réparer')
					.setStyle(ButtonStyle.Danger),
				new ButtonBuilder()
					.setCustomId('repair:ignore')
					.setLabel('✖️ Ignorer')
					.setStyle(ButtonStyle.Secondary)
			);
		} else {
			row.addComponents(
				new ButtonBuilder()
					.setCustomId('repair:ignore')
					.setLabel('✖️ Ignorer')
					.setStyle(ButtonStyle.Secondary)
			);
		}

		const alertChannel = await this.#getAlertChannel(guild);
		if (alertChannel) {
			await alertChannel.send({ embeds: [embed], components: [row] }).catch((err) => {
				this.logger?.warn({ err, guildId }, 'RepairService: Failed to send alert to setup channel');
			});
		} else {
			// Fallback: DM the owner
			await this.#dmOwner(guild, { embeds: [embed], components: [row] });
		}
	}

	#buildAlertContent(detected) {
		switch (detected.type) {
		case 'zone_category':
			return {
				title: `Zone "${detected.zone?.name}" — Catégorie supprimée`,
				description:
					`La catégorie Discord de la zone **${detected.zone?.name}** a été supprimée.\n` +
					'Ses salons sont maintenant orphelins (flottants dans le serveur).\n' +
					'Cliquez sur **Réparer** pour recréer la catégorie et y replacer les salons.',
				canRepair: true,
				confirmId: `repair:confirm:zcat:${detected.zoneId}`
			};

		case 'zone_channel': {
			const label = ZONE_CHANNEL_LABELS[detected.field] ?? detected.field;
			return {
				title: `Zone "${detected.zone?.name}" — Salon supprimé`,
				description:
					`Le salon **${label}** de la zone **${detected.zone?.name}** a été supprimé.\n` +
					'Cliquez sur **Réparer** pour le recréer automatiquement.',
				canRepair: true,
				confirmId: `repair:confirm:zch:${detected.zoneId}:${detected.field}`
			};
		}

		case 'zone_role': {
			const label = ZONE_ROLE_LABELS[detected.field] ?? detected.field;
			return {
				title: `Zone "${detected.zone?.name}" — Rôle supprimé`,
				description:
					`Le **${label}** de la zone **${detected.zone?.name}** a été supprimé.\n` +
					'Sans ce rôle, les membres de la zone n\'ont plus accès à ses salons.\n' +
					'Cliquez sur **Réparer** pour recréer le rôle et le réattribuer à tous les membres.',
				canRepair: true,
				confirmId: `repair:confirm:zrole:${detected.zoneId}:${detected.field}`
			};
		}

		case 'zone_custom_role':
			return {
				title: `Zone #${detected.zoneId} — Rôle custom supprimé`,
				description:
					`Le rôle custom **${detected.roleName ?? 'inconnu'}** de la zone #${detected.zoneId} a été supprimé.\n` +
					'Cliquez sur **Réparer** pour le recréer (sans réattribution automatique).',
				canRepair: true,
				confirmId: `repair:confirm:zcr:${detected.zoneId}:${detected.roleId}`
			};

		case 'settings_channel': {
			const label = SETTINGS_LABELS[detected.column] ?? detected.column;
			return {
				title: `Configuration — Salon "${label}" supprimé`,
				description:
					`Le salon **${label}** configuré dans les réglages du bot a été supprimé.\n` +
					'Ce salon ne peut pas être recréé automatiquement (c\'était un salon que vous aviez choisi).\n' +
					'Utilisez **/setup** pour le reconfigurer avec un nouveau salon.',
				canRepair: false,
				confirmId: null
			};
		}

		case 'setup_channel':
			return {
				title: 'Salon de configuration supprimé',
				description:
					'Le salon **#configuration-bot** a été supprimé.\n' +
					'Utilisez **/setup** pour le recréer.',
				canRepair: false,
				confirmId: null
			};

		case 'setup_message':
			return {
				title: 'Message de configuration supprimé',
				description:
					'Le message de panel de configuration du bot a été supprimé.\n' +
					'Utilisez **/setup** pour recréer le salon et son panel.',
				canRepair: false,
				confirmId: null
			};

		default:
			return {
				title: 'Ressource inconnue supprimée',
				description: 'Une ressource gérée par le bot a été supprimée.',
				canRepair: false,
				confirmId: null
			};
		}
	}

	// ─── Private: repair execution ────────────────────────────────────────────

	async #handleRepairConfirm(interaction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const parts = interaction.customId.split(':');
		// repair:confirm:{kind}:{...args}
		const kind = parts[2];

		try {
			const guild = interaction.guild;
			let message = '';

			if (kind === 'zcat') {
				const zoneId = Number(parts[3]);
				const zone = await this.#fetchZone(zoneId, guild.id);
				if (!zone) throw new Error('Zone introuvable');
				await restoreZoneCategory(this, guild, zone);
				message = `✅ Catégorie de la zone **${zone.name}** recréée et salons replacés.`;

			} else if (kind === 'zch') {
				const zoneId = Number(parts[3]);
				const field = parts[4];
				const zone = await this.#fetchZone(zoneId, guild.id);
				if (!zone) throw new Error('Zone introuvable');
				await restoreZoneChannel(this, guild, zone, field);
				message = `✅ Salon restauré pour la zone **${zone.name}**.`;

			} else if (kind === 'zrole') {
				const zoneId = Number(parts[3]);
				const field = parts[4];
				const zone = await this.#fetchZone(zoneId, guild.id);
				if (!zone) throw new Error('Zone introuvable');
				await restoreZoneRole(this, guild, zone, field);
				message = `✅ Rôle restauré et réattribué aux membres de la zone **${zone.name}**.`;

			} else if (kind === 'zcr') {
				const zoneId = Number(parts[3]);
				const oldRoleId = parts[4];
				const [rows] = await this.db.query(
					'SELECT name FROM zone_roles WHERE zone_id = ? AND role_id = ?',
					[zoneId, oldRoleId]
				);
				const roleName = rows[0]?.name ?? 'rôle supprimé';
				await restoreZoneCustomRole(this, guild, zoneId, roleName, oldRoleId);
				message = `✅ Rôle custom **${roleName}** recréé.`;

			} else {
				message = '⚠️ Action de réparation non reconnue.';
			}

			// Remove the repair buttons from the alert message
			await interaction.message?.edit({ components: [] }).catch(() => {});
			await interaction.editReply({ content: message });

		} catch (err) {
			this.logger?.error({ err }, 'RepairService: repair failed');
			await interaction.editReply({
				content: '❌ La réparation a échoué. Consultez les logs pour plus de détails.'
			});
		}
	}

	async #handleRepairAll(interaction) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		const guild = interaction.guild;
		const { issues } = await this.scanGuild(guild.id);

		let repaired = 0;
		let skipped = 0;
		const errors = [];

		for (const issue of issues) {
			try {
				if (issue.type === 'zone_category') {
					await restoreZoneCategory(this, guild, issue.zone);
					repaired++;
				} else if (issue.type === 'zone_channel') {
					await restoreZoneChannel(this, guild, issue.zone, issue.field);
					repaired++;
				} else if (issue.type === 'zone_role') {
					await restoreZoneRole(this, guild, issue.zone, issue.field);
					repaired++;
				} else if (issue.type === 'settings_channel') {
					await clearSettingsChannel(this, guild.id, issue.column);
					skipped++;
				} else {
					skipped++;
				}
			} catch (err) {
				this.logger?.error({ err, issue }, 'RepairService: repair all failed for issue');
				errors.push(issue.type);
			}
		}

		await interaction.message?.edit({ components: [] }).catch(() => {});

		let content = `✅ Réparation terminée : **${repaired}** ressource${repaired > 1 ? 's' : ''} restaurée${repaired > 1 ? 's' : ''}`;
		if (skipped > 0) content += `, **${skipped}** nécessite${skipped > 1 ? 'nt' : ''} une action manuelle (utilisez \`/setup\`)`;
		if (errors.length > 0) content += `\n⚠️ **${errors.length}** erreur${errors.length > 1 ? 's' : ''} — consultez les logs.`;

		return interaction.editReply({ content });
	}

	async #fetchZone(zoneId, guildId) {
		const [rows] = await this.db.query(
			`SELECT id, guild_id, name, slug, category_id,
			        text_panel_id, text_reception_id, text_general_id, text_anon_id, voice_id,
			        role_owner_id, role_member_id, role_muted_id
			 FROM zones WHERE id = ? AND guild_id = ?`,
			[zoneId, guildId]
		);
		return rows[0] ?? null;
	}

	async #getAlertChannel(guild) {
		const [rows] = await this.db.query(
			'SELECT setup_channel_id, anon_admin_channel_id FROM settings WHERE guild_id = ?',
			[guild.id]
		);
		const settings = rows[0];
		if (settings?.setup_channel_id) {
			return guild.channels.fetch(settings.setup_channel_id).catch(() => null);
		}
		return null;
	}

	async #dmOwner(guild, payload) {
		try {
			const ownerId = guild.ownerId;
			const owner = await this.client.users.fetch(ownerId).catch(() => null);
			if (owner) await owner.send(payload).catch(() => {});
		} catch {
			// DM failed — nothing more we can do
		}
	}
}

module.exports = { RepairService };
