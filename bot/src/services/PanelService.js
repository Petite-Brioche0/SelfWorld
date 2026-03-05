'use strict';

const {
	ChannelType,
	PermissionFlagsBits,
	MessageFlags,
} = require('discord.js');
const { columnExists } = require('../utils/serviceHelpers');

const render = require('./panel/render');
const members = require('./panel/members');
const roles = require('./panel/roles');
const channels = require('./panel/channels');

class PanelService {
	#schemaReady = false;
	#refreshLocks = new Map();

	constructor(client, db, logger = null, services = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
		this.services = services || null;
		this.activity = services?.activity || null;
	}

	/** @param {object} services - Service registry injected after construction */
	setServices(services) {
		this.services = services || null;
		this.activity = services?.activity || null;
	}

	/**
	 * Renders all panel sections for a newly created zone.
	 * @param {{ zone: object }} param0
	 */
	async renderInitialPanel({ zone }) {
		if (!zone?.id) return;
		try {
			await this.refresh(zone.id, ['members', 'roles', 'channels', 'policy', 'refresh']);
		} catch (err) {
			this.logger?.warn({ err, zoneId: zone?.id }, 'Failed to render initial panel');
		}
	}

	/**
	 * Creates or updates all panel messages for a zone in its panel channel.
	 * @param {object} zoneRow - Zone database row
	 * @returns {Promise<{ channel, record, messages }>}
	 */
	async ensurePanel(zoneRow) {
		await this.#ensureSchema();
		const channel = await this._fetchChannel(zoneRow.text_panel_id);
		if (!channel) throw new Error('panel channel missing');

		// ensure record
		let [rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		if (!rows.length) {
			await this.db.query('INSERT INTO panel_messages(zone_id) VALUES (?)', [zoneRow.id]);
			[rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		}
		let record = rows[0];

		const map = {
			members: { column: 'members_msg_id', render: () => this.renderMembers(zoneRow) },
			roles: { column: 'roles_msg_id', render: () => this.renderRoles(zoneRow) },
			channels: { column: 'channels_msg_id', render: () => this.renderChannels(zoneRow) },
			policy: { column: 'policy_msg_id', render: () => this.renderPolicy(zoneRow) },
			refresh: { column: 'refresh_msg_id', render: () => this.renderRefresh(zoneRow) }
		};

		const messages = {};

		for (const [key, meta] of Object.entries(map)) {
			const { embed, components } = await meta.render();
			let msgId = record[meta.column];
			let message = null;

			if (msgId) {
				try {
					message = await channel.messages.fetch(msgId);
					await message.edit({ embeds: [embed], components });
				} catch {
					message = await channel.send({ embeds: [embed], components });
				}
			} else {
				message = await channel.send({ embeds: [embed], components });
				msgId = message.id;
				await this.db.query(`UPDATE panel_messages SET ${meta.column} = ? WHERE zone_id = ?`, [msgId, zoneRow.id]);
				record = { ...record, [meta.column]: msgId };
			}
			messages[key] = { message, id: msgId };
		}

		try {
			await this.removeReceptionWelcome(zoneRow);
		} catch (err) {
			this.logger?.warn({ err, zoneId: zoneRow.id }, 'Failed to remove reception welcome message');
		}

		return { channel, record, messages };
	}

	/**
	 * Re-renders one or more panel sections for a zone. Serialized per-zone to prevent race conditions.
	 * @param {number} zoneId
	 * @param {string[]} [sections] - Subset of ['members','roles','channels','policy','refresh']. Defaults to all.
	 */
	async refresh(zoneId, sections = []) {
		// Serialize per-zone to prevent duplicate panel messages from concurrent calls
		const prev = this.#refreshLocks.get(zoneId) || Promise.resolve();
		const next = prev.then(() => this.#refreshInner(zoneId, sections)).catch((err) => {
			this.logger?.warn({ err, zoneId }, 'Panel refresh failed');
		});
		this.#refreshLocks.set(zoneId, next);
		return next;
	}

	async #refreshInner(zoneId, sections) {
		await this.#ensureSchema();
		const zoneRow = await this._getZone(zoneId);
		if (!zoneRow) throw new Error('zone not found');
		const channel = await this._fetchChannel(zoneRow.text_panel_id);
		if (!channel) throw new Error('panel channel missing');

		let [recordRows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		if (!recordRows.length) {
			await this.db.query('INSERT INTO panel_messages(zone_id) VALUES (?)', [zoneRow.id]);
			[recordRows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		}
		const record = recordRows[0];

		if (!sections.length) sections = ['members', 'roles', 'channels', 'policy', 'refresh'];

		const map = {
			members: { column: 'members_msg_id', render: () => this.renderMembers(zoneRow) },
			roles: { column: 'roles_msg_id', render: () => this.renderRoles(zoneRow) },
			channels: { column: 'channels_msg_id', render: () => this.renderChannels(zoneRow) },
			policy: { column: 'policy_msg_id', render: () => this.renderPolicy(zoneRow) },
			refresh: { column: 'refresh_msg_id', render: () => this.renderRefresh(zoneRow) }
		};

		for (const key of sections) {
			const meta = map[key];
			if (!meta) continue;
			const { embed, components } = await meta.render();
			let msgId = record[meta.column];
			if (!msgId) {
				const m = await channel.send({ embeds: [embed], components });
				msgId = m.id;
				await this.db.query(`UPDATE panel_messages SET ${meta.column}=? WHERE zone_id=?`, [msgId, zoneRow.id]);
				continue;
			}
			try {
				const msg = await channel.messages.fetch(msgId);
				await msg.edit({ embeds: [embed], components });
			} catch {
				const m = await channel.send({ embeds: [embed], components });
				await this.db.query(`UPDATE panel_messages SET ${meta.column}=? WHERE zone_id=?`, [m.id, zoneRow.id]);
			}
		}

		try {
			await this.removeReceptionWelcome(zoneRow);
		} catch (err) {
			this.logger?.warn({ err, zoneId: zoneRow.id }, 'Failed to remove reception welcome message');
		}
	}

	/**
	 * Deletes the reception welcome message for a zone if it exists in the panel records.
	 * @param {object} zoneRow - Zone database row
	 */
	async removeReceptionWelcome(zoneRow) {
		if (!zoneRow?.id) return;
		await this.#ensureSchema();

		const existingId = await this.#getPanelMessageId(zoneRow.id, 'reception_welcome');
		if (!existingId) return;

		const recep = await this._fetchChannel(zoneRow.text_reception_id);
		if (!recep?.isTextBased?.()) {
			await this.#setPanelMessageId(zoneRow.id, 'reception_welcome', null);
			return;
		}

		const msg = await recep.messages.fetch(existingId).catch(() => null);
		if (!msg) {
			await this.#setPanelMessageId(zoneRow.id, 'reception_welcome', null);
			return;
		}

		const deleted = await msg.delete().then(() => true).catch(() => false);
		if (deleted) {
			await this.#setPanelMessageId(zoneRow.id, 'reception_welcome', null);
		}
	}

	// ===== Interaction routers =====

	/**
	 * Routes panel select menu interactions to the appropriate domain handler.
	 * @param {import('discord.js').StringSelectMenuInteraction} interaction
	 * @returns {Promise<boolean>} true if handled
	 */
	async handleSelectMenu(interaction) {
		const id = interaction.customId || '';
		if (!id.startsWith('panel:')) return false;

		const parts = id.split(':');
		const zoneId = Number(parts[3] || parts.at(-1));
		if (!zoneId) {
			await interaction.reply({ content: '❌ **Zone invalide**\n\nCette zone n\'existe pas ou son identifiant est incorrect.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

		const zoneRow = await this._getZone(zoneId);
		if (!zoneRow) {
			await interaction.reply({ content: '❌ **Zone introuvable**\n\nCette zone n\'existe plus ou a été supprimée.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

		if (interaction.user.id !== String(zoneRow.owner_user_id)) {
			await interaction.reply({ content: '🔒 **Accès refusé**\n\nTu ne possèdes pas les permissions nécessaires pour gérer cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

		if (parts[1] === 'member') return this._handleMemberSelect(interaction, parts, zoneRow);
		if (parts[1] === 'role') return this._handleRoleSelect(interaction, parts, zoneRow);
		if (parts[1] === 'ch') return this._handleChannelSelect(interaction, parts, zoneRow);

		await interaction.deferUpdate().catch(() => { });
		return true;
	}

	/**
	 * Routes panel button interactions to the appropriate domain handler.
	 * @param {import('discord.js').ButtonInteraction} interaction
	 * @returns {Promise<boolean>} true if handled
	 */
	async handleButton(interaction) {
		const id = interaction.customId || '';
		if (!id.startsWith('panel:')) return false;
		const parts = id.split(':');
		const zoneId = Number(parts[3] || parts.at(-1));
		if (!zoneId) {
			await interaction.reply({ content: '❌ **Zone invalide**\n\nCette zone n\'existe pas ou son identifiant est incorrect.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const zoneRow = await this._getZone(zoneId);
		if (!zoneRow) {
			await interaction.reply({ content: '❌ **Zone introuvable**\n\nCette zone n\'existe plus ou a été supprimée.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		if (interaction.user.id !== String(zoneRow.owner_user_id)) {
			await interaction.reply({ content: '🔒 **Accès refusé**\n\nTu ne possèdes pas les permissions nécessaires pour gérer cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

		if (parts[1] === 'refresh') {
			try {
				await interaction.deferUpdate().catch((err) => {
					this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to defer panel refresh');
				});
				await this.refresh(zoneRow.id, ['members', 'roles', 'channels', 'policy', 'refresh']);
				if (!interaction.deferred && !interaction.replied) {
					await interaction
						.reply({ content: '✅ **Panneau actualisé**\n\nLe panneau de gestion a été mis à jour avec les dernières informations.', flags: MessageFlags.Ephemeral })
						.catch((err) => {
							if (err?.code === 10062 || err?.rawError?.code === 10062) return;
							this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send panel refresh confirmation');
						});
				} else {
					await interaction
						.followUp({ content: '✅ **Panneau actualisé**\n\nLe panneau de gestion a été mis à jour avec les dernières informations.', flags: MessageFlags.Ephemeral })
						.catch((err) => {
							if (err?.code === 10062 || err?.rawError?.code === 10062) return;
							this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send panel refresh confirmation');
						});
				}
			} catch (err) {
				this.logger?.warn({ err, zoneId: zoneRow.id }, 'Failed to refresh panel via button');
				if (!interaction.deferred && !interaction.replied) {
					await interaction
						.reply({ content: '❌ **Erreur d\'actualisation**\n\nImpossible de rafraîchir le panneau pour le moment. Réessaye dans quelques instants.', flags: MessageFlags.Ephemeral })
						.catch((err2) => {
							if (err2?.code === 10062 || err2?.rawError?.code === 10062) return;
							this.logger?.warn({ err: err2, userId: interaction?.user?.id }, 'Failed to send panel refresh error');
						});
				} else {
					await interaction
						.followUp({ content: '❌ **Erreur d\'actualisation**\n\nImpossible de rafraîchir le panneau pour le moment. Réessaye dans quelques instants.', flags: MessageFlags.Ephemeral })
						.catch((err2) => {
							if (err2?.code === 10062 || err2?.rawError?.code === 10062) return;
							this.logger?.warn({ err: err2, userId: interaction?.user?.id }, 'Failed to send panel refresh error');
						});
				}
			}
			return true;
		}

		if (parts[1] === 'member') return this._handleMemberButton(interaction, parts, zoneRow);
		if (parts[1] === 'role') return this._handleRoleButton(interaction, parts, zoneRow);
		if (parts[1] === 'ch') return this._handleChannelButton(interaction, parts, zoneRow);

		await interaction.deferUpdate().catch(() => { });
		return true;
	}

	/**
	 * Routes panel modal submissions to the appropriate domain handler.
	 * @param {import('discord.js').ModalSubmitInteraction} interaction
	 * @returns {Promise<boolean>} true if handled
	 */
	async handleModal(interaction) {
		const id = interaction.customId || '';
		if (!id.startsWith('panel:')) return false;
		const parts = id.split(':');
		const zoneId = Number(parts[3] || parts.at(-1));
		if (!zoneId) {
			await interaction.reply({ content: '❌ **Zone invalide**\n\nCette zone n\'existe pas ou son identifiant est incorrect.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const zoneRow = await this._getZone(zoneId);
		if (!zoneRow) {
			await interaction.reply({ content: '❌ **Zone introuvable**\n\nCette zone n\'existe plus ou a été supprimée.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		if (interaction.user.id !== String(zoneRow.owner_user_id)) {
			await interaction.reply({ content: '🔒 **Accès refusé**\n\nTu ne possèdes pas les permissions nécessaires pour gérer cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

		if (parts[1] === 'role') return this._handleRoleModal(interaction, parts, zoneRow);
		if (parts[1] === 'ch') return this._handleChannelModal(interaction, parts, zoneRow);

		await interaction.reply({ content: '❌ **Action invalide**\n\nCette action n\'est pas reconnue ou n\'est plus disponible.', flags: MessageFlags.Ephemeral }).catch(() => { });
		return true;
	}

	// ===== Shared infrastructure =====

	_getActivityService() {
		if (this.activity) return this.activity;
		const fromServices = this.services?.activity || this.client?.context?.services?.activity || null;
		if (fromServices) {
			this.activity = fromServices;
		}
		return this.activity;
	}

	async _getZone(zoneId) {
		const [rows] = await this.db.query('SELECT * FROM zones WHERE id=?', [zoneId]);
		return rows?.[0] || null;
	}

	async _fetchChannel(id) {
		if (!id) return null;
		try { return await this.client.channels.fetch(id); } catch { return null; }
	}

	async _collectZoneMembers(zoneRow) {
		const guild = await this.client.guilds.fetch(zoneRow.guild_id);
		const memberIds = new Map();

		const collect = async (roleId) => {
			if (!roleId) return;
			const role = await guild.roles.fetch(roleId).catch(() => null);
			if (!role) return;
			for (const member of role.members.values()) {
				memberIds.set(member.id, member);
			}
		};

		await collect(zoneRow.role_member_id);
		await collect(zoneRow.role_owner_id);

		const members = [...memberIds.values()].sort((a, b) => {
			const nameA = a.displayName?.toLowerCase?.() || a.user?.username?.toLowerCase?.() || '';
			const nameB = b.displayName?.toLowerCase?.() || b.user?.username?.toLowerCase?.() || '';
			return nameA.localeCompare(nameB, 'fr', { sensitivity: 'base' });
		});

		return { guild, members };
	}

	async _collectZoneRoles(zoneRow) {
		const guild = await this.client.guilds.fetch(zoneRow.guild_id);
		const ownerRole = await guild.roles.fetch(zoneRow.role_owner_id).catch(() => null);
		const memberRole = await guild.roles.fetch(zoneRow.role_member_id).catch(() => null);
		let [customRows] = await this.db.query(
			'SELECT role_id, name, color FROM zone_roles WHERE zone_id = ? ORDER BY name ASC',
			[zoneRow.id]
		);
		customRows = Array.isArray(customRows) ? customRows : [];

		const customRoles = [];
		for (const row of customRows) {
			const role = await guild.roles.fetch(row.role_id).catch(() => null);
			if (!role) continue;
			customRoles.push({ role, row });
		}

		return {
			guild,
			coreRoles: {
				owner: ownerRole,
				member: memberRole
			},
			customRoles
		};
	}

	async _collectZoneChannels(zoneRow) {
		const guild = await this.client.guilds.fetch(zoneRow.guild_id);
		const category = await this._fetchChannel(zoneRow.category_id);
		if (!category) {
			return { guild, channels: [] };
		}

		const protectedIds = new Set(
			[zoneRow.text_panel_id, zoneRow.text_reception_id, zoneRow.text_anon_id].filter(Boolean)
		);

		const fetched = await guild.channels.fetch();
		const channelList = [...fetched.values()]
			.filter((channel) => channel?.parentId === category.id)
			.map((channel) => ({ channel, isProtected: protectedIds.has(channel.id) }))
			.sort((a, b) => a.channel.rawPosition - b.channel.rawPosition);

		return { guild, channels: channelList };
	}

	async _addMemberRoleRecord(zoneRow, memberId, roleId) {
		if (!zoneRow?.id || !memberId || !roleId) return;
		await this.db.query(
			'INSERT INTO zone_member_roles (zone_id, role_id, user_id) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE user_id = new.user_id',
			[zoneRow.id, roleId, memberId]
		);
	}

	async _removeMemberRoleRecord(zoneRow, memberId, roleId) {
		if (!zoneRow?.id || !memberId || !roleId) return;
		await this.db.query('DELETE FROM zone_member_roles WHERE zone_id = ? AND role_id = ? AND user_id = ?', [
			zoneRow.id,
			roleId,
			memberId
		]);
	}

	async _replaceMemberRoleRecords(zoneRow, memberId, desiredRoleIds) {
		if (!zoneRow?.id || !memberId) return;
		const desired = new Set((desiredRoleIds ? [...desiredRoleIds] : []).filter(Boolean));
		const [rows] = await this.db.query(
			'SELECT role_id FROM zone_member_roles WHERE zone_id = ? AND user_id = ?',
			[zoneRow.id, memberId]
		);
		const current = new Set(Array.isArray(rows) ? rows.map((row) => row.role_id) : []);

		const toAdd = [...desired].filter((roleId) => !current.has(roleId));
		const toRemove = [...current].filter((roleId) => !desired.has(roleId));

		for (const roleId of toAdd) {
			await this._addMemberRoleRecord(zoneRow, memberId, roleId);
		}

		if (toRemove.length) {
			const placeholders = toRemove.map(() => '?').join(',');
			await this.db.query(
				`DELETE FROM zone_member_roles WHERE zone_id = ? AND user_id = ? AND role_id IN (${placeholders})`,
				[zoneRow.id, memberId, ...toRemove]
			);
		}
	}

	async _syncZoneMembership(zoneRow, memberId, { hasOwnerRole = false, hasMemberRole = false } = {}) {
		if (!zoneRow?.id || !memberId) return;

		if (hasOwnerRole) {
			await this.db.query(
				'INSERT INTO zone_members (zone_id, user_id, role) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE role = new.role',
				[zoneRow.id, memberId, 'owner']
			);
			return;
		}

		if (hasMemberRole) {
			await this.db.query(
				'INSERT INTO zone_members (zone_id, user_id, role) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE role = new.role',
				[zoneRow.id, memberId, 'member']
			);
			return;
		}

		await this.db.query('DELETE FROM zone_members WHERE zone_id = ? AND user_id = ?', [zoneRow.id, memberId]);
	}

	async _removeAllMemberRoleRecords(zoneRow, memberId) {
		if (!zoneRow?.id || !memberId) return;
		await this.db.query('DELETE FROM zone_member_roles WHERE zone_id = ? AND user_id = ?', [zoneRow.id, memberId]);
	}

	async _removeRoleAssignments(zoneRow, roleId) {
		if (!zoneRow?.id || !roleId) return;
		await this.db.query('DELETE FROM zone_member_roles WHERE zone_id = ? AND role_id = ?', [zoneRow.id, roleId]);
	}

	_buildChannelPermissionOverwrites(guild, zoneRow, channel, allowedRoleIds, botRole = null, { denyRoleIds = [] } = {}) {
		const overwrites = [];
		const everyoneRole = guild.roles.everyone;
		if (everyoneRole) {
			overwrites.push({ id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] });
		}

		const textAllow = [
			PermissionFlagsBits.ViewChannel,
			PermissionFlagsBits.SendMessages,
			PermissionFlagsBits.ReadMessageHistory
		];
		const voiceAllow = [
			PermissionFlagsBits.ViewChannel,
			PermissionFlagsBits.Connect,
			PermissionFlagsBits.Speak
		];

		const ownerAllow = channel.type === ChannelType.GuildVoice ? voiceAllow : textAllow;
		if (zoneRow.role_owner_id) {
			overwrites.push({ id: zoneRow.role_owner_id, allow: ownerAllow });
		}

		const unique = new Set(allowedRoleIds || []);
		unique.delete(zoneRow.role_owner_id);
		for (const roleId of unique) {
			if (!roleId) continue;
			const allow = channel.type === ChannelType.GuildVoice ? voiceAllow : textAllow;
			overwrites.push({ id: roleId, allow });
		}

		const denyBase = [PermissionFlagsBits.ViewChannel];
		if (channel.type === ChannelType.GuildVoice) {
			denyBase.push(PermissionFlagsBits.Connect);
		}

		const denySet = new Set(denyRoleIds || []);
		denySet.delete(zoneRow.role_owner_id);
		for (const roleId of denySet) {
			if (!roleId) continue;
			if (unique.has(roleId)) continue;
			overwrites.push({ id: roleId, deny: denyBase });
		}

		if (botRole) {
			const allow = channel.type === ChannelType.GuildVoice
				? [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.Connect,
					PermissionFlagsBits.Speak,
					PermissionFlagsBits.MoveMembers,
					PermissionFlagsBits.MuteMembers,
					PermissionFlagsBits.DeafenMembers,
					PermissionFlagsBits.ManageChannels
				]
				: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.SendMessages,
					PermissionFlagsBits.ReadMessageHistory,
					PermissionFlagsBits.ManageChannels,
					PermissionFlagsBits.ManageMessages
				];
			overwrites.push({ id: botRole.id, allow });
		}

		return overwrites;
	}

	_parseTags(raw) {
		if (!raw) return [];
		if (Array.isArray(raw)) {
			return raw
				.map((entry) => String(entry || '').trim().toLowerCase())
				.filter((entry) => entry.length)
				.slice(0, 10);
		}
		if (typeof raw === 'string') {
			try {
				const parsed = JSON.parse(raw);
				if (Array.isArray(parsed)) {
					return this._parseTags(parsed);
				}
			} catch { /* ignored */ }
			return raw
				.split(',')
				.map((entry) => entry.trim().toLowerCase())
				.filter((entry) => entry.length)
				.slice(0, 10);
		}
		return [];
	}

	_parseChannelType(raw) {
		if (!raw) return null;
		const input = raw.trim().toLowerCase();
		const simplified = input
			.normalize('NFD')
			.replace(/\p{Diacritic}/gu, '')
			.replace(/\s+/g, '');
		if (['text', 'texte', 'txt', 'textuel', 'salontexte', 'salontextuel'].includes(simplified)) {
			return ChannelType.GuildText;
		}
		if (['voice', 'vocal', 'voc', 'voicechannel', 'salonvocal', 'audio'].includes(simplified)) {
			return ChannelType.GuildVoice;
		}
		return null;
	}

	async _resolveZoneColor(zoneRow, guild = null) {
		try {
			const g = guild || (await this.client.guilds.fetch(zoneRow.guild_id));
			if (zoneRow.role_owner_id) {
				const ownerRole = await g.roles.fetch(zoneRow.role_owner_id).catch(() => null);
				if (ownerRole?.color) return ownerRole.color;
			}
			if (zoneRow.role_member_id) {
				const memberRole = await g.roles.fetch(zoneRow.role_member_id).catch(() => null);
				if (memberRole?.color) return memberRole.color;
			}
		} catch { /* ignored */ }
		return 0x5865f2;
	}

	async #ensureSchema() {
		if (this.#schemaReady) return;
		await this.db.query(`CREATE TABLE IF NOT EXISTS panel_messages (
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
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		if (!(await columnExists(this.db, 'panel_messages', 'refresh_msg_id'))) {
			await this.db
				.query('ALTER TABLE `panel_messages` ADD COLUMN refresh_msg_id VARCHAR(32) NULL AFTER zone_id')
				.catch(() => {
					// Expected failure if column already exists - intentionally silent
				});
		}
		await this.db.query(`CREATE TABLE IF NOT EXISTS panel_message_registry (
			zone_id BIGINT UNSIGNED NOT NULL,
			kind VARCHAR(32) NOT NULL,
			message_id VARCHAR(32) NOT NULL,
			PRIMARY KEY(zone_id, kind),
			FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		await this.db.query(`CREATE TABLE IF NOT EXISTS zone_roles (
			id INT AUTO_INCREMENT PRIMARY KEY,
			zone_id BIGINT UNSIGNED NOT NULL,
			role_id VARCHAR(32) NOT NULL,
			name VARCHAR(64) NOT NULL,
			color VARCHAR(7) NULL,
			UNIQUE KEY uq_zone_role (zone_id, role_id),
			INDEX ix_zone (zone_id),
			FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		await this.db.query(`CREATE TABLE IF NOT EXISTS zone_member_roles (
			zone_id BIGINT UNSIGNED NOT NULL,
			role_id VARCHAR(32) NOT NULL,
			user_id VARCHAR(32) NOT NULL,
			PRIMARY KEY(zone_id, role_id, user_id),
			FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		this.#schemaReady = true;
	}

	async #getPanelMessageId(zoneId, kind) {
		if (!zoneId || !kind) return null;
		const [rows] = await this.db.query(
			'SELECT message_id FROM panel_message_registry WHERE zone_id = ? AND kind = ? LIMIT 1',
			[zoneId, kind]
		);
		return rows?.[0]?.message_id || null;
	}

	async #setPanelMessageId(zoneId, kind, messageId) {
		if (!zoneId || !kind) return;
		if (!messageId) {
			await this.db
				.query('DELETE FROM panel_message_registry WHERE zone_id = ? AND kind = ?', [zoneId, kind])
				.catch((err) => {
					this.logger?.warn({ err, zoneId, kind }, 'Failed to delete panel message registry entry');
				});
			return;
		}
		await this.db.query(
			'INSERT INTO panel_message_registry (zone_id, kind, message_id) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE message_id = new.message_id',
			[zoneId, kind, messageId]
		);
	}
}

Object.assign(PanelService.prototype, render, members, roles, channels);
module.exports = { PanelService };
