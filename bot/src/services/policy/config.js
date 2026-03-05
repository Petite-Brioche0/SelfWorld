const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
	TextInputBuilder,
	TextInputStyle
} = require('discord.js');
const { applyZoneOverwrites } = require('../../utils/permissions');
const { normalizeColor } = require('../../utils/serviceHelpers');
const { sanitizeName } = require('../../utils/validation');

const POLICY_VALUES = new Set(['open', 'ask', 'closed']);
const ASK_MODES = new Set(['request', 'invite', 'both']);
const APPROVER_MODES = new Set(['owner', 'members']);

// --- Module-local helpers ---

function _sanitizeTags(raw) {
	if (!raw) return [];
	let source = raw;
	if (Array.isArray(raw)) {
		source = raw;
	} else if (typeof raw === 'string') {
		source = raw.split(',');
	} else {
		return [];
	}
	return source
		.map((entry) => String(entry || '').trim().toLowerCase())
		.filter((entry) => entry.length)
		.slice(0, 8);
}

function _buildProfileModal(zone) {
	const modal = new ModalBuilder()
		.setCustomId(`panel:policy:profile:modal:${zone.id}`)
		.setTitle('Profil public de la zone');

	const titleInput = new TextInputBuilder()
		.setCustomId('policyProfileTitle')
		.setLabel('Titre public')
		.setStyle(TextInputStyle.Short)
		.setValue(zone.profile_title || zone.name || '')
		.setRequired(true)
		.setMaxLength(100);

	const descInput = new TextInputBuilder()
		.setCustomId('policyProfileDesc')
		.setLabel('Description (optionnel)')
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(false)
		.setMaxLength(1000)
		.setValue(zone.profile_desc?.slice(0, 1000) || '');

	const colorInput = new TextInputBuilder()
		.setCustomId('policyProfileColor')
		.setLabel('Couleur (#RRGGBB)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(7)
		.setValue(zone.profile_color || '');

	const tags = Array.isArray(zone.profile_tags) ? zone.profile_tags.join(', ') : '';
	const tagsInput = new TextInputBuilder()
		.setCustomId('policyProfileTags')
		.setLabel('Tags (séparés par des virgules)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(200)
		.setValue(tags);

	modal.addComponents(
		new ActionRowBuilder().addComponents(titleInput),
		new ActionRowBuilder().addComponents(descInput),
		new ActionRowBuilder().addComponents(colorInput),
		new ActionRowBuilder().addComponents(tagsInput)
	);

	return modal;
}

async function _resolveOwnerColor(svc, zone) {
	if (!zone) throw new Error('Zone invalide');
	const guild = await svc.client.guilds.fetch(zone.guild_id);
	if (zone.role_owner_id) {
		const ownerRole = await guild.roles.fetch(zone.role_owner_id).catch(() => null);
		if (ownerRole?.hexColor && ownerRole.hexColor !== '#000000') {
			return ownerRole.hexColor.toUpperCase();
		}
	}
	if (zone.role_member_id) {
		const memberRole = await guild.roles.fetch(zone.role_member_id).catch(() => null);
		if (memberRole?.hexColor && memberRole.hexColor !== '#000000') {
			return memberRole.hexColor.toUpperCase();
		}
	}
	return '#5865F2';
}

async function _findInterviewRoom(svc, zone) {
	if (!zone?.category_id) return null;
	try {
		const guild = await svc.client.guilds.fetch(zone.guild_id);
		const collection = await guild.channels.fetch();
		return (
			[...collection.values()].find(
				(channel) =>
					channel?.type === ChannelType.GuildText &&
					channel?.parentId === zone.category_id &&
					channel?.name === 'cv-entretien'
			) || null
		);
	} catch (err) {
		svc.logger?.warn({ err, zoneId: zone?.id }, 'Failed to find cv-entretien channel');
		return null;
	}
}

async function _applyInterviewPermissions(svc, zone, channel) {
	if (!channel) return;
	try {
		const guild = channel.guild || (await svc.client.guilds.fetch(zone.guild_id));
		const ownerRole = zone.role_owner_id
			? await guild.roles.fetch(zone.role_owner_id).catch(() => null)
			: null;
		const memberRole = zone.role_member_id
			? await guild.roles.fetch(zone.role_member_id).catch(() => null)
			: null;
		const botMember = guild.members.me || (await guild.members.fetch(svc.client.user.id).catch(() => null));
		const botRole = botMember?.roles?.highest || null;

		const overwrites = [
			{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
		];
		if (memberRole) {
			overwrites.push({ id: memberRole.id, deny: [PermissionFlagsBits.ViewChannel] });
		}
		if (ownerRole) {
			overwrites.push({
				id: ownerRole.id,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.SendMessages,
					PermissionFlagsBits.ReadMessageHistory,
					PermissionFlagsBits.AttachFiles,
					PermissionFlagsBits.EmbedLinks
				]
			});
		}
		if (botRole) {
			overwrites.push({
				id: botRole.id,
				allow: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.SendMessages,
					PermissionFlagsBits.ManageMessages,
					PermissionFlagsBits.ReadMessageHistory,
					PermissionFlagsBits.ManageChannels
				]
			});
		}

		await channel.permissionOverwrites.set(overwrites);

		if (channel.parent) {
			await applyZoneOverwrites(
				channel.parent,
				{
					everyoneRole: guild.roles.everyone,
					zoneMemberRole: memberRole,
					zoneOwnerRole: ownerRole
				},
				botRole,
				{
					panel: await guild.channels.fetch(zone.text_panel_id).catch(() => null),
					reception: await guild.channels.fetch(zone.text_reception_id).catch(() => null),
					general: await guild.channels.fetch(zone.text_general_id).catch(() => null),
					chuchotement: await guild.channels.fetch(zone.text_anon_id).catch(() => null),
					voice: await guild.channels.fetch(zone.voice_id).catch(() => null),
					interview: channel
				}
			).catch((err) => {
				svc.logger?.warn({ err, zoneId: zone.id }, 'Failed to apply zone overwrites to category');
			});
		}
	} catch (err) {
		svc.logger?.warn({ err, zoneId: zone.id }, 'Failed to apply interview permissions');
	}
}

async function _deleteStoredAnchor(svc, channelId, messageId) {
	if (!channelId || !messageId) return;
	const channel = await svc.client.channels.fetch(channelId).catch(() => null);
	if (!channel?.isTextBased?.()) return;
	const message = await channel.messages.fetch(messageId).catch(() => null);
	if (!message) return;
	await message.unpin().catch((err) => {
		svc.logger?.warn({ err, messageId, channelId }, 'Failed to unpin anchor message');
	});
	await message.delete().catch((err) => {
		if (err?.code === 10008) return;
		svc.logger?.warn({ err, messageId, channelId }, 'Failed to delete anchor message');
	});
}

// --- Mixin methods ---

module.exports = {
	// PUBLIC: Handle policy select menu
	async handlePolicySelect(interaction) {
		const [, , action, zoneIdRaw] = interaction.customId.split(':');
		if (action !== 'set') return false;
		const zoneId = Number(zoneIdRaw);
		if (!zoneId || !interaction.values?.length) {
			await interaction.reply({ content: 'Sélection invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid policy selection reply');
			});
			return true;
		}

		const zone = await this._getZone(zoneId);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send policy zone-not-found reply');
			});
			return true;
		}

		if (!(await this._isZoneOwner(zone, interaction.user.id))) {
			await interaction.reply({ content: "Seul l'owner peut modifier la politique.", flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send policy owner-only reply');
			});
			return true;
		}

		const nextPolicy = interaction.values[0];
		try {
			await interaction.deferUpdate();
		} catch (err) {
			if (err?.code === 10062 || err?.rawError?.code === 10062) return;
			this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer update');
		}

		try {
			await this.setPolicy(zoneId, nextPolicy, interaction.user.id);
			await this._syncPolicyPanelMessage(interaction, zoneId);
			await this._refreshPanel(zoneId);
			await interaction.followUp({
				content: `Politique mise à jour sur **${nextPolicy}**.`,
				flags: MessageFlags.Ephemeral
			});
		} catch (err) {
			this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to set policy from panel');
			await interaction.followUp({
				content: `Impossible de mettre à jour la politique : ${err.message || err}`,
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send policy update error');
			});
		}

		return true;
	},

	// PUBLIC: Handle profile edit button
	async handleProfileButton(interaction) {
		const parts = interaction.customId.split(':');
		const zoneId = Number(parts.at(-1));
		if (!zoneId) {
			await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid profile zone reply');
			});
			return true;
		}
		const zone = await this._getZone(zoneId);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile zone-not-found reply');
			});
			return true;
		}
		if (!(await this._isZoneOwner(zone, interaction.user.id))) {
			await interaction.reply({ content: "Seul l'owner peut modifier le profil.", flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile owner-only reply');
			});
			return true;
		}

		const modal = _buildProfileModal(zone);
		await interaction.showModal(modal);
		return true;
	},

	// PUBLIC: Handle profile modal submission
	async handleProfileModal(interaction) {
		const parts = interaction.customId.split(':');
		const zoneId = Number(parts.at(-1));
		if (!zoneId) {
			await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid profile modal zone reply');
			});
			return true;
		}

		const zone = await this._getZone(zoneId);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile modal zone-not-found reply');
			});
			return true;
		}

		if (!(await this._isZoneOwner(zone, interaction.user.id))) {
			await interaction.reply({ content: "Seul l'owner peut modifier le profil.", flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile modal owner-only reply');
			});
			return true;
		}

		const payload = {
			profile_title: interaction.fields.getTextInputValue('policyProfileTitle')?.trim(),
			profile_desc: interaction.fields.getTextInputValue('policyProfileDesc')?.trim(),
			profile_color: interaction.fields.getTextInputValue('policyProfileColor')?.trim(),
			profile_tags: interaction.fields.getTextInputValue('policyProfileTags')?.trim()
		};

		try {
			await this.updateProfile(zoneId, payload, interaction.user.id);
			await interaction.reply({
				content: 'Profil public mis à jour ✅',
				flags: MessageFlags.Ephemeral
			});
			await this._refreshPanel(zoneId);
		} catch (err) {
			this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to update policy profile');
			await interaction.reply({
				content: `Impossible de mettre à jour le profil : ${err.message || err}`,
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile update error');
			});
		}

		return true;
	},

	// PUBLIC: Handle ask mode select menu
	async handleAskModeSelect(interaction) {
		const zoneId = Number(interaction.customId.split(':').at(-1));
		if (!zoneId) {
			await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid ask-mode zone reply');
			});
			return true;
		}
		const zone = await this._getZone(zoneId);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send ask-mode zone-not-found reply');
			});
			return true;
		}
		if (zone.policy !== 'ask') {
			await interaction.reply({ content: "Cette zone n'est pas en mode demande.", flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send not-ask-mode reply');
			});
			return true;
		}
		if (!(await this._isZoneOwner(zone, interaction.user.id))) {
			await interaction.reply({ content: "Seul l'owner peut modifier ce réglage.", flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send ask-mode owner-only reply');
			});
			return true;
		}

		const mode = interaction.values?.[0];
		if (!mode) {
			await interaction.reply({ content: 'Sélection invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send invalid ask-mode selection reply');
			});
			return true;
		}

		try {
			await interaction.deferUpdate();
		} catch (err) {
			if (err?.code === 10062 || err?.rawError?.code === 10062) return;
			this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer update');
		}

		try {
			await this.setAskMode(zoneId, mode, interaction.user.id);
			await interaction.followUp({ content: 'Mode de demande mis à jour.', flags: MessageFlags.Ephemeral });
			await this._refreshPanel(zoneId);
		} catch (err) {
			this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to set ask mode');
			await interaction.followUp({
				content: `Impossible de modifier le mode : ${err.message || err}`,
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send ask-mode update error');
			});
		}
		return true;
	},

	// PUBLIC: Handle approver select menu
	async handleApproverSelect(interaction) {
		const zoneId = Number(interaction.customId.split(':').at(-1));
		if (!zoneId) {
			await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid approver zone reply');
			});
			return true;
		}
		const zone = await this._getZone(zoneId);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send approver zone-not-found reply');
			});
			return true;
		}
		if (zone.policy !== 'ask') {
			await interaction.reply({ content: "Cette zone n'est pas en mode demande.", flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send approver not-ask-mode reply');
			});
			return true;
		}
		if (!(await this._isZoneOwner(zone, interaction.user.id))) {
			await interaction.reply({ content: "Seul l'owner peut modifier ce réglage.", flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send approver owner-only reply');
			});
			return true;
		}

		const mode = interaction.values?.[0];
		if (!mode) {
			await interaction.reply({ content: 'Sélection invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send invalid approver selection reply');
			});
			return true;
		}

		try {
			await interaction.deferUpdate();
		} catch (err) {
			if (err?.code === 10062 || err?.rawError?.code === 10062) return;
			this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer update');
		}

		try {
			await this.setApproverMode(zoneId, mode, interaction.user.id);
			await interaction.followUp({ content: 'Décideur mis à jour.', flags: MessageFlags.Ephemeral });
			await this._refreshPanel(zoneId);
		} catch (err) {
			this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to set approver mode');
			await interaction.followUp({
				content: `Impossible de modifier le décideur : ${err.message || err}`,
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send approver update error');
			});
		}
		return true;
	},

	// PUBLIC: Set zone policy
	async setPolicy(zoneId, policy, actorId = null) {
		await this.ensureSchema();
		if (!POLICY_VALUES.has(policy)) {
			throw new Error('Politique inconnue.');
		}
		const zone = await this._getZone(zoneId);
		if (!zone) throw new Error('Zone introuvable');

		const updates = { policy };
		if (policy === 'open') {
			if (!zone.profile_title) updates.profile_title = zone.name || 'Zone';
			if (!zone.profile_color) {
				try {
					updates.profile_color = await _resolveOwnerColor(this, zone);
				} catch (err) {
					this.logger?.debug({ err, zoneId: zone.id }, 'Failed to resolve owner color, using default');
					updates.profile_color = '#5865F2';
				}
			}
		}

		if (policy === 'ask') {
			if (!ASK_MODES.has(zone.ask_join_mode)) updates.ask_join_mode = 'request';
			if (!APPROVER_MODES.has(zone.ask_approver_mode)) updates.ask_approver_mode = 'owner';
		} else {
			updates.ask_join_mode = null;
			updates.ask_approver_mode = null;
		}

		const placeholders = [];
		const values = [];
		for (const [key, value] of Object.entries(updates)) {
			placeholders.push(`${key} = ?`);
			values.push(value);
		}
		values.push(zoneId);
		await this.db.query(`UPDATE zones SET ${placeholders.join(', ')} WHERE id = ?`, values);

		this.logger?.info({ zoneId, actorId, policy }, 'Zone policy updated');

		const updatedZone = await this._getZone(zoneId);

		if (policy === 'ask') {
			if ((updatedZone.ask_approver_mode || 'owner') === 'owner') {
				await this._ensureInterviewRoom(updatedZone);
			} else {
				await this._cleanupInterviewRoom(updatedZone);
			}
			await this._cleanupCodeAnchor(updatedZone);
		} else {
			await this._cleanupInterviewRoom(updatedZone);
			await this._cleanupCodeAnchor(updatedZone);
		}
	},

	// PUBLIC: Update zone profile
	async updateProfile(zoneId, data, actorId = null) {
		await this.ensureSchema();
		const zone = await this._getZone(zoneId);
		if (!zone) throw new Error('Zone introuvable');
		const updates = {};

		const title = (data.profile_title || '').trim();
		if (!title) throw new Error('Le titre est obligatoire.');
		updates.profile_title = title.slice(0, 100);

		const desc = (data.profile_desc || '').trim();
		updates.profile_desc = desc ? desc.slice(0, 1000) : null;

		const color = normalizeColor(data.profile_color);
		if (data.profile_color && !color) {
			throw new Error('Couleur invalide. Utilise un format #RRGGBB.');
		}
		updates.profile_color = color;

		const tags = _sanitizeTags(data.profile_tags);
		updates.profile_tags = tags.length ? JSON.stringify(tags) : null;

		const columns = [];
		const values = [];
		for (const [key, value] of Object.entries(updates)) {
			columns.push(`${key} = ?`);
			values.push(value);
		}
		values.push(zoneId);
		await this.db.query(`UPDATE zones SET ${columns.join(', ')} WHERE id = ?`, values);
		this.logger?.info({ zoneId, actorId }, 'Zone profile updated');
	},

	// PUBLIC: Set ask join mode
	async setAskMode(zoneId, mode, actorId = null) {
		await this.ensureSchema();
		if (!ASK_MODES.has(mode)) throw new Error('Mode invalide');
		const zone = await this._getZone(zoneId);
		if (!zone) throw new Error('Zone introuvable');
		if (zone.policy !== 'ask') throw new Error('Politique incompatible');

		await this.db.query('UPDATE zones SET ask_join_mode = ? WHERE id = ?', [mode, zoneId]);
		this.logger?.info({ zoneId, actorId, mode }, 'Ask mode updated');

		const updatedZone = await this._getZone(zoneId);
		await this._cleanupCodeAnchor(updatedZone);
	},

	// PUBLIC: Set approver mode
	async setApproverMode(zoneId, mode, actorId = null) {
		await this.ensureSchema();
		if (!APPROVER_MODES.has(mode)) throw new Error('Mode invalide');
		const zone = await this._getZone(zoneId);
		if (!zone) throw new Error('Zone introuvable');
		if (zone.policy !== 'ask') throw new Error('Politique incompatible');

		await this.db.query('UPDATE zones SET ask_approver_mode = ? WHERE id = ?', [mode, zoneId]);
		this.logger?.info({ zoneId, actorId, mode }, 'Approver mode updated');

		const updatedZone = await this._getZone(zoneId);

		if (mode === 'owner') {
			await this._ensureInterviewRoom(updatedZone);
		} else {
			await this._cleanupInterviewRoom(updatedZone);
		}

		await this._cleanupCodeAnchor(updatedZone);
	},

	// PUBLIC: List discoverable zones
	async listDiscoverableZones({ limit = 3, offset = 0 } = {}) {
		await this.ensureSchema();
		const clampedLimit = Math.min(Math.max(1, Number(limit) || 3), 5);
		const safeOffset = Math.max(0, Number(offset) || 0);

		const [rows] = await this.db.query(
			`SELECT * FROM zones
			WHERE policy = 'open'
			   OR (policy = 'ask' AND ask_join_mode IN ('request','both'))
			ORDER BY name ASC
			LIMIT ? OFFSET ?`,
			[clampedLimit, safeOffset]
		);

		const [countRows] = await this.db.query(
			"SELECT COUNT(*) AS total FROM zones WHERE policy = 'open' OR (policy = 'ask' AND ask_join_mode IN ('request','both'))"
		);

		const total = countRows?.[0]?.total || 0;

		return {
			zones: rows.map((row) => this._hydrateZoneRow(row)),
			total
		};
	},

	// Internal: Normalize policy input string to enum value
	_normalizePolicyInput(input) {
		const value = sanitizeName(input).toLowerCase();
		if (!value) return null;
		if (['ferme', 'fermé', 'closed', 'close'].includes(value)) return 'closed';
		if (['sur demande', 'demande', 'ask', 'request'].includes(value)) return 'ask';
		if (['ouvert', 'open'].includes(value)) return 'open';
		return null;
	},

	// Internal: Get French label for policy
	_policyLabel(policy) {
		switch (policy) {
			case 'open':
				return 'Ouvert';
			case 'closed':
				return 'Fermé';
			case 'ask':
			default:
				return 'Sur demande';
		}
	},

	// Internal: Sync policy panel message
	async _syncPolicyPanelMessage(interaction, zoneId) {
		if (!interaction?.message?.id || !zoneId) return false;

		let updated = false;
		if (this.panelService?.renderPolicy && typeof interaction.message.edit === 'function') {
			const zone = await this._getZone(zoneId);
			if (!zone) return false;
			try {
				const { embed, components } = await this.panelService.renderPolicy(zone);
				await interaction.message.edit({ embeds: [embed], components });
				updated = true;
			} catch (err) {
				this.logger?.warn({ err, zoneId }, 'Failed to update policy panel message from interaction');
			}
		}

		try {
			await this.db.query(
				'INSERT INTO panel_messages (zone_id, policy_msg_id) VALUES (?, ?) AS new ON DUPLICATE KEY UPDATE policy_msg_id = new.policy_msg_id',
				[zoneId, interaction.message.id]
			);
		} catch (err) {
			if (err?.code !== 'ER_NO_SUCH_TABLE') {
				this.logger?.warn({ err, zoneId }, 'Failed to sync policy panel message id');
			}
		}

		return updated;
	},

	// Internal: Ensure interview room exists for a zone
	async _ensureInterviewRoom(zone) {
		try {
			const guild = await this.client.guilds.fetch(zone.guild_id);
			const existing = await _findInterviewRoom(this, zone);
			if (existing) return existing;

			const channel = await guild.channels.create({
				name: 'cv-entretien',
				type: ChannelType.GuildText,
				parent: zone.category_id,
				reason: 'Zone join requests (owner)',
				topic: 'Salon privé pour examiner les demandes d\'entrée.'
			});

			await _applyInterviewPermissions(this, zone, channel);

			const panelChannel = await guild.channels.fetch(zone.text_panel_id).catch(() => null);
			if (panelChannel?.parentId === channel.parentId) {
				await channel.setPosition(panelChannel.position + 1).catch((err) => {
					this.logger?.warn({ err, channelId: channel.id, zoneId: zone.id }, 'Failed to set interview room position');
				});
			}

			this.logger?.info({ zoneId: zone.id, channelId: channel.id }, 'Created cv-entretien channel');
			return channel;
		} catch (err) {
			this.logger?.warn({ err, zoneId: zone.id }, 'Failed to ensure cv-entretien');
			throw err;
		}
	},

	// Internal: Cleanup interview room for a zone
	async _cleanupInterviewRoom(zone) {
		const channel = await _findInterviewRoom(this, zone);
		if (!channel) return;
		try {
			await channel.delete('Zone join requests mode updated');
			this.logger?.info({ zoneId: zone.id, channelId: channel.id }, 'Deleted cv-entretien channel');
		} catch (err) {
			this.logger?.warn({ err, zoneId: zone.id, channelId: channel.id }, 'Failed to delete cv-entretien channel');
		}
	},

	// Internal: Find interview room for a zone
	async _findInterviewRoom(zone) {
		return _findInterviewRoom(this, zone);
	},

	// Internal: Cleanup code anchor
	async _cleanupCodeAnchor(zone) {
		const record = await this._ensurePanelRecord(zone.id);
		if (!record) return;
		if (record.code_anchor_channel_id && record.code_anchor_message_id) {
			await _deleteStoredAnchor(this, record.code_anchor_channel_id, record.code_anchor_message_id);
		}
		await this.db.query(
			'UPDATE panel_messages SET code_anchor_channel_id = NULL, code_anchor_message_id = NULL WHERE zone_id = ?',
			[zone.id]
		).catch((err) => {
			this.logger?.warn({ err, zoneId: zone.id }, 'Failed to clear code anchor references');
		});
	},

	// Internal: Ensure code anchor (currently unused but preserved)
	async _ensureCodeAnchor(zone) {
		const record = await this._ensurePanelRecord(zone.id);
		const channel = await this._resolveCodeChannel(zone);
		if (!channel) return null;

		let message = null;
		if (record?.code_anchor_channel_id && record?.code_anchor_message_id) {
			if (record.code_anchor_channel_id === channel.id) {
				message = await channel.messages.fetch(record.code_anchor_message_id).catch(() => null);
			} else {
				await _deleteStoredAnchor(this, record.code_anchor_channel_id, record.code_anchor_message_id);
			}
		}

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`panel:policy:code:gen:${zone.id}`)
				.setLabel('Générer un code')
				.setStyle(ButtonStyle.Secondary)
		);

		const content = (zone.ask_approver_mode || 'owner') === 'owner'
			? 'Clique pour générer un code d\u2019invitation à partager au candidat.'
			: 'Les membres peuvent générer un code temporaire et le transmettre en privé.';

		if (message) {
			await message.edit({ content, components: [row] }).catch((err) => {
				if (err?.code === 10008) return;
				this.logger?.warn({ err, messageId: message?.id, zoneId: zone.id }, 'Failed to edit code anchor');
			});
		} else {
			message = await channel.send({ content, components: [row] });
			if ((zone.ask_approver_mode || 'owner') === 'members') {
				await message.pin().catch((err) => {
					this.logger?.warn({ err, messageId: message?.id, zoneId: zone.id }, 'Failed to pin code anchor');
				});
			}
		}

		await this.db.query(
			'INSERT INTO panel_messages (zone_id, code_anchor_channel_id, code_anchor_message_id) VALUES (?, ?, ?) AS new ON DUPLICATE KEY UPDATE code_anchor_channel_id = new.code_anchor_channel_id, code_anchor_message_id = new.code_anchor_message_id',
			[zone.id, message.channelId, message.id]
		);

		return message;
	},

	// Internal: Resolve code channel based on approver mode
	async _resolveCodeChannel(zone) {
		const approver = zone.ask_approver_mode || 'owner';
		if (approver === 'owner') {
			return this._ensureInterviewRoom(zone);
		}
		if (!zone.text_reception_id) return null;
		return this.client.channels.fetch(zone.text_reception_id).catch(() => null);
	},

	// Internal: Sync invite anchors (currently unused but preserved)
	async _syncInviteAnchors(zone) {
		if (!zone?.id) return;
		await this._cleanupCodeAnchor(zone);
	},
};
