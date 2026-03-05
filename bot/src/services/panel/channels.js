'use strict';

const {
	ActionRowBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	ChannelType,
	MessageFlags,
} = require('discord.js');

// ===== Channel interaction handlers — mixed into PanelService.prototype =====

async function _handleChannelSelect(interaction, parts, zoneRow) {
	if (parts[2] === 'select') {
		const channelId = interaction.values?.[0] || null;
		const { embed, components } = await this.renderChannels(zoneRow, channelId);
		await interaction.update({ embeds: [embed], components }).catch(() => { });
		return true;
	}

	if (parts[2] === 'roles') {
		const channelId = parts[4];
		if (!channelId) {
			await interaction.reply({ content: '❌ **Salon invalide**\n\nCe salon est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		await interaction.deferUpdate().catch(() => { });
		try {
			const { guild } = await this._collectZoneChannels(zoneRow);
			const channel = await guild.channels.fetch(channelId).catch(() => null);
			if (!channel) throw new Error('channel not found');

			const { coreRoles, customRoles } = await this._collectZoneRoles(zoneRow);
			const validRoleIds = new Set();
			const denyRoleIds = new Set();
			if (coreRoles.member) {
				validRoleIds.add(coreRoles.member.id);
				denyRoleIds.add(coreRoles.member.id);
			} else if (zoneRow.role_member_id) {
				denyRoleIds.add(zoneRow.role_member_id);
			}
			for (const entry of customRoles) {
				validRoleIds.add(entry.role.id);
				denyRoleIds.add(entry.role.id);
			}

			const selectedIds = new Set((interaction.values || []).filter((value) => validRoleIds.has(value)));
			if (zoneRow.role_owner_id) selectedIds.add(zoneRow.role_owner_id);

			const botMember = guild.members.me || (await guild.members.fetch(this.client.user.id).catch(() => null));
			const botRole = botMember?.roles?.highest || null;

			const overwrites = this._buildChannelPermissionOverwrites(guild, zoneRow, channel, selectedIds, botRole, {
				denyRoleIds: [...denyRoleIds]
			});
			await channel.permissionOverwrites.set(overwrites);

			const { embed, components } = await this.renderChannels(zoneRow, channelId);
			await interaction.message.edit({ embeds: [embed], components }).catch(() => { });
		} catch (_err) {
			await interaction.followUp?.({ content: '❌ **Erreur de mise à jour**\n\nImpossible de mettre à jour les permissions du salon. Vérifie qu\'il existe toujours.', flags: MessageFlags.Ephemeral }).catch(() => { });
		}
		return true;
	}

	await interaction.deferUpdate().catch(() => { });
	return true;
}

async function _handleChannelButton(interaction, parts, zoneRow) {
	const channelId = parts[4];

	if (parts[2] === 'add') {
		const modal = new ModalBuilder()
			.setCustomId(`panel:ch:create:${zoneRow.id}`)
			.setTitle('Créer un salon');
		const nameInput = new TextInputBuilder()
			.setCustomId('channelName')
			.setLabel('Nom du salon')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(100);
		const typeInput = new TextInputBuilder()
			.setCustomId('channelType')
			.setLabel('Type (texte ou vocal)')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(10);
		const descriptionInput = new TextInputBuilder()
			.setCustomId('channelDescription')
			.setLabel('Description (optionnel)')
			.setStyle(TextInputStyle.Paragraph)
			.setRequired(false)
			.setMaxLength(1024);
		modal.addComponents(
			new ActionRowBuilder().addComponents(nameInput),
			new ActionRowBuilder().addComponents(typeInput),
			new ActionRowBuilder().addComponents(descriptionInput)
		);
		await interaction.showModal(modal);
		return true;
	}

	const { channels } = await this._collectZoneChannels(zoneRow);
	const entry = channelId ? channels.find((item) => item.channel.id === channelId) : null;

	if (parts[2] === 'modify') {
		if (!entry) {
			await interaction.reply({ content: '❌ **Salon introuvable**\n\nCe salon n\'existe plus ou a été supprimé de cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		if (entry.isProtected) {
			await interaction.reply({ content: '🔒 **Salon protégé**\n\nCe salon est protégé par le système et ne peut pas être modifié.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const channel = entry.channel;
		const modal = new ModalBuilder()
			.setCustomId(`panel:ch:update:${zoneRow.id}:${channel.id}`)
			.setTitle('Modifier le salon');
		const nameInput = new TextInputBuilder()
			.setCustomId('channelName')
			.setLabel('Nom du salon')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setValue(channel.name.slice(0, 100));
		const descriptionInput = new TextInputBuilder()
			.setCustomId('channelDescription')
			.setLabel('Description (optionnel)')
			.setStyle(TextInputStyle.Paragraph)
			.setRequired(false);
		if (channel.type === ChannelType.GuildText && channel.topic) {
			descriptionInput.setValue(channel.topic.slice(0, 1024));
		}
		modal.addComponents(
			new ActionRowBuilder().addComponents(nameInput),
			new ActionRowBuilder().addComponents(descriptionInput)
		);
		await interaction.showModal(modal);
		return true;
	}

	if (parts[2] === 'delete') {
		if (!entry) {
			await interaction.reply({ content: '❌ **Salon introuvable**\n\nCe salon n\'existe plus ou a été supprimé de cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		if (entry.isProtected) {
			await interaction.reply({ content: '🔒 **Salon protégé**\n\nCe salon est protégé par le système et ne peut pas être supprimé.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const { embed, components } = await this.renderChannels(zoneRow, entry.channel.id, { confirmDeleteFor: entry.channel.id });
		await interaction.update({ embeds: [embed], components }).catch(() => { });
		return true;
	}

	if (parts[2] === 'delete-cancel') {
		const selectedId = entry?.channel.id || null;
		const { embed, components } = await this.renderChannels(zoneRow, selectedId);
		await interaction.update({ embeds: [embed], components }).catch(() => { });
		return true;
	}

	if (parts[2] === 'delete-confirm') {
		if (!entry) {
			await interaction.deferUpdate().catch(() => { });
			return true;
		}
		if (entry.isProtected) {
			await interaction.deferUpdate().catch(() => { });
			await interaction.followUp({ content: '🔒 **Salon protégé**\n\nCe salon est protégé par le système et ne peut pas être supprimé.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		await interaction.deferUpdate().catch(() => { });
		try {
			const guild = await this.client.guilds.fetch(zoneRow.guild_id);
			const channel = await guild.channels.fetch(entry.channel.id).catch(() => null);
			if (channel) await channel.delete(`Suppression via panneau de zone #${zoneRow.id}`).catch((err) => { this.logger?.debug({ err }, 'Failed to delete resource'); });
			await this.refresh(zoneRow.id, ['channels']);
			await interaction.followUp({ content: '✅ **Salon supprimé**\n\nLe salon a été supprimé avec succès de cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
		} catch (_err) {
			await interaction.followUp({ content: '❌ **Suppression impossible**\n\nCe salon ne peut pas être supprimé pour le moment. Vérifie qu\'il existe toujours.', flags: MessageFlags.Ephemeral }).catch(() => { });
		}
		return true;
	}

	await interaction.deferUpdate().catch(() => { });
	return true;
}

async function _handleChannelModal(interaction, parts, zoneRow) {
	if (parts[2] === 'create') {
		const nameRaw = (interaction.fields.getTextInputValue('channelName') || '').trim();
		const typeRaw = (interaction.fields.getTextInputValue('channelType') || '').trim();
		const description = (interaction.fields.getTextInputValue('channelDescription') || '').trim();
		if (!nameRaw.length) {
			await interaction.reply({ content: '⚠️ **Nom requis**\n\nTu dois fournir un nom pour créer ce salon.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const channelType = this._parseChannelType(typeRaw);
		if (channelType === null) {
			await interaction.reply({ content: '❌ **Type invalide**\n\nUtilise `texte` pour un salon textuel ou `vocal` pour un salon vocal.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
		try {
			const { guild, customRoles, coreRoles } = await this._collectZoneRoles(zoneRow);
			const channel = await guild.channels.create({
				name: nameRaw.slice(0, 100),
				type: channelType,
				parent: zoneRow.category_id,
				topic: channelType === ChannelType.GuildText ? (description || undefined) : undefined,
				reason: `Création via panneau de zone #${zoneRow.id}`
			});
			const botMember = guild.members.me || (await guild.members.fetch(this.client.user.id).catch(() => null));
			const botRole = botMember?.roles?.highest || null;
			const allowed = new Set();
			if (zoneRow.role_owner_id) allowed.add(zoneRow.role_owner_id);
			if (coreRoles.member) {
				allowed.add(coreRoles.member.id);
			} else if (zoneRow.role_member_id) {
				allowed.add(zoneRow.role_member_id);
			}
			const denyRoleIds = new Set();
			if (coreRoles.member) {
				denyRoleIds.add(coreRoles.member.id);
			} else if (zoneRow.role_member_id) {
				denyRoleIds.add(zoneRow.role_member_id);
			}
			for (const entry of customRoles) denyRoleIds.add(entry.role.id);
			const overwrites = this._buildChannelPermissionOverwrites(guild, zoneRow, channel, allowed, botRole, {
				denyRoleIds: [...denyRoleIds]
			});
			await channel.permissionOverwrites.set(overwrites);
			await interaction.editReply({ content: `✅ **Salon créé**\n\nLe salon ${channelType === ChannelType.GuildVoice ? 'vocal' : 'textuel'} a été créé avec succès dans cette zone.` }).catch(() => { });
			await this.refresh(zoneRow.id, ['channels']);
		} catch (_err) {
			await interaction.editReply({ content: '❌ **Création impossible**\n\nImpossible de créer ce salon pour le moment. Réessaye dans quelques instants.' }).catch(() => { });
		}
		return true;
	}

	if (parts[2] === 'update') {
		const channelId = parts[4];
		const nameRaw = (interaction.fields.getTextInputValue('channelName') || '').trim();
		const description = (interaction.fields.getTextInputValue('channelDescription') || '').trim();
		if (!channelId || !nameRaw.length) {
			await interaction.reply({ content: '❌ **Salon invalide**\n\nCe salon est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
		try {
			const guild = await this.client.guilds.fetch(zoneRow.guild_id);
			const channel = await guild.channels.fetch(channelId).catch(() => null);
			if (!channel) {
				await interaction.editReply({ content: '❌ **Salon introuvable**\n\nCe salon n\'existe plus ou a été supprimé de cette zone.' }).catch(() => { });
				return true;
			}
			const { channels } = await this._collectZoneChannels(zoneRow);
			const entry = channels.find((item) => item.channel.id === channelId);
			if (entry?.isProtected) {
				await interaction.editReply({ content: '🔒 **Salon protégé**\n\nCe salon est protégé par le système et ne peut pas être modifié.' }).catch(() => { });
				return true;
			}
			const safeName = nameRaw.slice(0, 100);
			if (channel.type === ChannelType.GuildVoice) {
				await channel.setName(safeName).catch(() => { });
			} else {
				await channel.edit({ name: safeName, topic: description || null }).catch(() => { });
			}
			await interaction.editReply({ content: '✅ **Salon mis à jour**\n\nLes modifications du salon ont été appliquées avec succès.' }).catch(() => { });
			await this.refresh(zoneRow.id, ['channels']);
		} catch (_err) {
			await interaction.editReply({ content: '❌ **Modification impossible**\n\nImpossible de modifier ce salon. Vérifie qu\'il existe toujours et réessaye.' }).catch(() => { });
		}
		return true;
	}

	await interaction.reply({ content: '❌ **Action invalide**\n\nCette action n\'est pas reconnue ou n\'est plus disponible.', flags: MessageFlags.Ephemeral }).catch(() => { });
	return true;
}

module.exports = {
	_handleChannelSelect,
	_handleChannelButton,
	_handleChannelModal,
};
