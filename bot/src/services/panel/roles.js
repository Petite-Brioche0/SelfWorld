'use strict';

const {
	ActionRowBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	MessageFlags,
} = require('discord.js');
const { normalizeColor } = require('../../utils/serviceHelpers');

// ===== Role interaction handlers — mixed into PanelService.prototype =====

async function _handleRoleSelect(interaction, parts, zoneRow) {
	if (parts[2] === 'select') {
		const selectedRoleId = interaction.values?.[0] || null;
		const { embed, components } = await this.renderRoles(zoneRow, selectedRoleId);
		await interaction.update({ embeds: [embed], components }).catch(() => { });
		return true;
	}

	if (parts[2] === 'members') {
		const roleId = parts[4];
		if (!roleId) {
			await interaction.reply({ content: '❌ **Rôle invalide**\n\nCe rôle est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		await interaction.deferUpdate().catch(() => { });
		try {
			const { guild } = await this._collectZoneRoles(zoneRow);
			const role = await guild.roles.fetch(roleId).catch(() => null);
			if (!role) throw new Error('role not found');

			const { members: zoneMembers } = await this._collectZoneMembers(zoneRow);
			const zoneMemberMap = new Map(zoneMembers.map((member) => [member.id, member]));
			const selectedIds = new Set((interaction.values || []).filter((value) => zoneMemberMap.has(value)));

			const currentAssignments = new Set(
				[...role.members.values()].filter((member) => zoneMemberMap.has(member.id)).map((member) => member.id)
			);

			const toAdd = [...selectedIds].filter((id) => !currentAssignments.has(id));
			const toRemove = [...currentAssignments].filter((id) => !selectedIds.has(id));

			const addedSuccessfully = [];
			for (const memberId of toAdd) {
				const member = zoneMemberMap.get(memberId);
				if (!member) continue;
				try {
					await member.roles.add(role);
					addedSuccessfully.push(memberId);
				} catch { /* ignored */ }
			}

			const removedSuccessfully = [];
			for (const memberId of toRemove) {
				const member = zoneMemberMap.get(memberId) || (await guild.members.fetch(memberId).catch(() => null));
				if (!member) continue;
				try {
					await member.roles.remove(role);
					removedSuccessfully.push(memberId);
				} catch { /* ignored */ }
			}

			for (const memberId of addedSuccessfully) {
				await this._addMemberRoleRecord(zoneRow, memberId, role.id);
			}

			for (const memberId of removedSuccessfully) {
				await this._removeMemberRoleRecord(zoneRow, memberId, role.id);
			}

			const { embed, components } = await this.renderRoles(zoneRow, roleId);
			await interaction.message.edit({ embeds: [embed], components }).catch(() => { });
		} catch (_err) {
			await interaction.followUp?.({ content: '❌ **Erreur de mise à jour**\n\nImpossible de mettre à jour les membres du rôle. Vérifie que le rôle existe toujours.', flags: MessageFlags.Ephemeral }).catch(() => { });
		}
		return true;
	}

	await interaction.deferUpdate().catch(() => { });
	return true;
}

async function _handleRoleButton(interaction, parts, zoneRow) {
	const roleId = parts[4];

	if (parts[2] === 'add') {
		const modal = new ModalBuilder()
			.setCustomId(`panel:role:create:${zoneRow.id}`)
			.setTitle('Créer un rôle');
		const nameInput = new TextInputBuilder()
			.setCustomId('roleName')
			.setLabel('Nom du rôle')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(100);
		const colorInput = new TextInputBuilder()
			.setCustomId('roleColor')
			.setLabel('Couleur (#RRGGBB) — optionnel')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(7);
		modal.addComponents(
			new ActionRowBuilder().addComponents(nameInput),
			new ActionRowBuilder().addComponents(colorInput)
		);
		await interaction.showModal(modal);
		return true;
	}

	if (parts[2] === 'modify') {
		if (!roleId) {
			await interaction.reply({ content: '❌ **Rôle invalide**\n\nCe rôle est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const { customRoles } = await this._collectZoneRoles(zoneRow);
		const entry = customRoles.find((item) => item.role.id === roleId);
		if (!entry) {
			await interaction.reply({ content: '🔒 **Rôle protégé**\n\nCe rôle est introuvable ou ne peut pas être modifié car il est protégé par le système.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const modal = new ModalBuilder()
			.setCustomId(`panel:role:update:${zoneRow.id}:${roleId}`)
			.setTitle('Modifier le rôle');
		const nameInput = new TextInputBuilder()
			.setCustomId('roleName')
			.setLabel('Nom du rôle')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setValue(entry.role.name.slice(0, 100));
		const colorValue = entry.row?.color || (entry.role.hexColor && entry.role.hexColor !== '#000000' ? entry.role.hexColor : '');
		const colorInput = new TextInputBuilder()
			.setCustomId('roleColor')
			.setLabel('Couleur (#RRGGBB) — optionnel')
			.setStyle(TextInputStyle.Short)
			.setRequired(false);
		if (colorValue) colorInput.setValue(colorValue);
		modal.addComponents(
			new ActionRowBuilder().addComponents(nameInput),
			new ActionRowBuilder().addComponents(colorInput)
		);
		await interaction.showModal(modal);
		return true;
	}

	if (parts[2] === 'delete') {
		if (!roleId) {
			await interaction.reply({ content: '❌ **Rôle invalide**\n\nCe rôle est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const { embed, components } = await this.renderRoles(zoneRow, roleId, { confirmDeleteFor: roleId });
		await interaction.update({ embeds: [embed], components }).catch(() => { });
		return true;
	}

	if (parts[2] === 'delete-cancel') {
		const selectedId = roleId || null;
		const { embed, components } = await this.renderRoles(zoneRow, selectedId);
		await interaction.update({ embeds: [embed], components }).catch(() => { });
		return true;
	}

	if (parts[2] === 'delete-confirm') {
		if (!roleId) {
			await interaction.deferUpdate().catch(() => { });
			return true;
		}
		await interaction.deferUpdate().catch(() => { });
		try {
			const { guild } = await this._collectZoneRoles(zoneRow);
			const role = await guild.roles.fetch(roleId).catch(() => null);
			if (role) await role.delete(`Suppression via panneau de zone #${zoneRow.id}`).catch((err) => { this.logger?.debug({ err }, 'Failed to delete resource'); });
			await this._removeRoleAssignments(zoneRow, roleId).catch((err) => { this.logger?.debug({ err }, 'Failed to clean up records'); });
			await this.db.query('DELETE FROM zone_roles WHERE zone_id = ? AND role_id = ?', [zoneRow.id, roleId]);
			await this.refresh(zoneRow.id, ['roles']);
			await interaction.followUp({ content: '✅ **Rôle supprimé**\n\nLe rôle a été supprimé avec succès de cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
		} catch (_err) {
			await interaction.followUp({ content: '❌ **Suppression impossible**\n\nCe rôle ne peut pas être supprimé pour le moment. Vérifie qu\'il existe toujours.', flags: MessageFlags.Ephemeral }).catch(() => { });
		}
		return true;
	}

	await interaction.deferUpdate().catch(() => { });
	return true;
}

async function _handleRoleModal(interaction, parts, zoneRow) {
	if (parts[2] === 'create') {
		const nameRaw = (interaction.fields.getTextInputValue('roleName') || '').trim();
		const colorRaw = (interaction.fields.getTextInputValue('roleColor') || '').trim();
		if (!nameRaw.length) {
			await interaction.reply({ content: '⚠️ **Nom requis**\n\nTu dois fournir un nom pour créer ce rôle.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const color = colorRaw ? normalizeColor(colorRaw) : null;
		if (colorRaw && !color) {
			await interaction.reply({ content: '❌ **Couleur invalide**\n\nUtilise le format hexadécimal : `#RRGGBB` (ex: `#5865F2` pour bleu Discord).', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
		try {
			const { guild, customRoles } = await this._collectZoneRoles(zoneRow);
			if (customRoles.length >= 10) {
				await interaction.editReply({ content: '⚠️ **Limite atteinte**\n\nTu as déjà créé le maximum de rôles personnalisés autorisés (10) pour cette zone.' }).catch(() => { });
				return true;
			}
			const safeName = nameRaw.slice(0, 100);
			const role = await guild.roles.create({
				name: safeName,
				color: color || undefined,
				mentionable: false,
				reason: `Création via panneau de zone #${zoneRow.id}`
			});
			await this.db.query(
				'INSERT INTO zone_roles (zone_id, role_id, name, color) VALUES (?, ?, ?, ?) AS new ON DUPLICATE KEY UPDATE name = new.name, color = new.color',
				[zoneRow.id, role.id, safeName.slice(0, 64), color || null]
			);
			await interaction.editReply({ content: `✅ **Rôle créé**\n\nLe rôle <@&${role.id}> a été créé avec succès dans cette zone.` }).catch(() => { });
			await this.refresh(zoneRow.id, ['roles']);
		} catch (_err) {
			await interaction.editReply({ content: '❌ **Création impossible**\n\nImpossible de créer ce rôle pour le moment. Réessaye dans quelques instants.' }).catch(() => { });
		}
		return true;
	}

	if (parts[2] === 'update') {
		const roleId = parts[4];
		const nameRaw = (interaction.fields.getTextInputValue('roleName') || '').trim();
		const colorRaw = (interaction.fields.getTextInputValue('roleColor') || '').trim();
		if (!roleId || !nameRaw.length) {
			await interaction.reply({ content: '❌ **Rôle invalide**\n\nCe rôle est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const normalizedColor = colorRaw ? normalizeColor(colorRaw) : null;
		if (colorRaw && !normalizedColor) {
			await interaction.reply({ content: '❌ **Couleur invalide**\n\nUtilise le format hexadécimal : `#RRGGBB` (ex: `#5865F2` pour bleu Discord).', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
		try {
			const { guild } = await this._collectZoneRoles(zoneRow);
			const role = await guild.roles.fetch(roleId).catch(() => null);
			if (!role) {
				await interaction.editReply({ content: '❌ **Rôle introuvable**\n\nCe rôle n\'existe plus ou a été supprimé de cette zone.' }).catch(() => { });
				return true;
			}
			const safeName = nameRaw.slice(0, 100);
			const payload = { name: safeName };
			if (colorRaw === '') {
				payload.color = null;
			} else if (normalizedColor) {
				payload.color = normalizedColor;
			}
			await role.edit(payload).catch(() => { });
			await this.db.query(
				'INSERT INTO zone_roles (zone_id, role_id, name, color) VALUES (?, ?, ?, ?) AS new ON DUPLICATE KEY UPDATE name = new.name, color = new.color',
				[zoneRow.id, role.id, safeName.slice(0, 64), colorRaw === '' ? null : normalizedColor]
			);
			await interaction.editReply({ content: '✅ **Rôle mis à jour**\n\nLes modifications du rôle ont été appliquées avec succès.' }).catch(() => { });
			await this.refresh(zoneRow.id, ['roles']);
		} catch (_err) {
			await interaction.editReply({ content: '❌ **Modification impossible**\n\nImpossible de modifier ce rôle. Vérifie qu\'il existe toujours et réessaye.' }).catch(() => { });
		}
		return true;
	}

	await interaction.reply({ content: '❌ **Action invalide**\n\nCette action n\'est pas reconnue ou n\'est plus disponible.', flags: MessageFlags.Ephemeral }).catch(() => { });
	return true;
}

module.exports = {
	_handleRoleSelect,
	_handleRoleButton,
	_handleRoleModal,
};
