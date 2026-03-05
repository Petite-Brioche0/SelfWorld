'use strict';

const { MessageFlags } = require('discord.js');

// ===== Member interaction handlers — mixed into PanelService.prototype =====

async function _handleMemberSelect(interaction, parts, zoneRow) {
	if (parts[2] === 'select') {
		const selectedId = interaction.values?.[0];
		const { embed, components } = await this.renderMembers(zoneRow, selectedId);
		await interaction.update({ embeds: [embed], components }).catch(() => { });
		return true;
	}

	if (parts[2] === 'assignRole') {
		const memberId = parts[4];
		if (!memberId) {
			await interaction.reply({ content: '❌ **Membre invalide**\n\nCe membre est introuvable ou n\'est plus dans ce serveur.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const values = interaction.values || [];
		await interaction.deferUpdate().catch(() => { });
		try {
			const { guild, members } = await this._collectZoneMembers(zoneRow);
			const member = members.find((m) => m.id === memberId) || (await guild.members.fetch(memberId).catch(() => null));
			if (!member) throw new Error('member not found');

			const { coreRoles, customRoles } = await this._collectZoneRoles(zoneRow);
			const assignableIds = new Set(customRoles.map((entry) => entry.role.id));

			const desired = new Set(values.filter((v) => assignableIds.has(v)));

			const current = new Set(
				(member.roles?.cache ? [...member.roles.cache.keys()] : []).filter((id) => assignableIds.has(id))
			);

			const toAdd = [...desired].filter((id) => !current.has(id));
			const toRemove = [...current].filter((id) => !desired.has(id));

			if (toAdd.length) {
				await member.roles.add(toAdd).catch((err) => { this.logger?.debug({ err }, 'Failed to update member roles'); });
			}
			if (toRemove.length) {
				await member.roles.remove(toRemove).catch((err) => { this.logger?.debug({ err }, 'Failed to update member roles'); });
			}

			const refreshed = await guild.members.fetch(memberId).catch(() => null);
			const snapshot = refreshed || member;
			const updatedRoleIds = new Set(
				snapshot.roles?.cache
					? [...snapshot.roles.cache.keys()].filter((id) => assignableIds.has(id))
					: []
			);
			const hasOwnerRole = coreRoles.owner
				? snapshot.roles?.cache?.has?.(coreRoles.owner.id) || false
				: false;
			const hasMemberRole = coreRoles.member
				? snapshot.roles?.cache?.has?.(coreRoles.member.id) || false
				: false;

			await this._replaceMemberRoleRecords(zoneRow, memberId, updatedRoleIds);
			await this._syncZoneMembership(zoneRow, memberId, { hasOwnerRole, hasMemberRole });

			const { embed, components } = await this.renderMembers(zoneRow, memberId);
			await interaction.editReply({ embeds: [embed], components }).catch(() => { });
		} catch (_err) {
			await interaction.followUp?.({ content: '❌ **Erreur de mise à jour**\n\nImpossible de mettre à jour les rôles pour le moment. Réessaye dans quelques instants.', flags: MessageFlags.Ephemeral }).catch(() => { });
		}
		return true;
	}

	await interaction.deferUpdate().catch(() => { });
	return true;
}

async function _handleMemberButton(interaction, parts, zoneRow) {
	const memberId = parts[4];

	if (parts[2] === 'kick') {
		if (!memberId) {
			await interaction.reply({ content: '❌ **Membre invalide**\n\nCe membre est introuvable ou n\'est plus dans ce serveur.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		if (memberId === String(zoneRow.owner_user_id)) {
			await interaction.reply({ content: '🔒 **Action interdite**\n\nLe propriétaire de la zone ne peut pas être exclu.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const { embed, components } = await this.renderMembers(zoneRow, memberId, { confirmKickFor: memberId });
		await interaction.update({ embeds: [embed], components }).catch(() => { });
		return true;
	}

	if (parts[2] === 'kick-confirm') {
		if (!memberId) {
			await interaction.reply({ content: '❌ **Membre invalide**\n\nCe membre est introuvable ou n\'est plus dans ce serveur.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		if (memberId === String(zoneRow.owner_user_id)) {
			await interaction.reply({ content: '🔒 **Action interdite**\n\nLe propriétaire ne peut pas être exclu de sa propre zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		await interaction.deferUpdate().catch(() => { });
		try {
			const { guild } = await this._collectZoneMembers(zoneRow);
			const member = await guild.members.fetch(memberId).catch(() => null);
			if (member) {
				const roleIds = new Set();
				if (zoneRow.role_member_id) roleIds.add(zoneRow.role_member_id);
				if (zoneRow.role_owner_id) roleIds.add(zoneRow.role_owner_id);
				const { customRoles } = await this._collectZoneRoles(zoneRow);
				for (const entry of customRoles) roleIds.add(entry.role.id);
				await member.roles.remove([...roleIds]).catch((err) => { this.logger?.debug({ err }, 'Failed to update member roles'); });
			}
			await this._removeAllMemberRoleRecords(zoneRow, memberId).catch((err) => { this.logger?.debug({ err }, 'Failed to clean up records'); });
			await this.db.query('DELETE FROM zone_members WHERE zone_id = ? AND user_id = ?', [zoneRow.id, memberId]).catch((err) => { this.logger?.debug({ err }, 'Failed to clean up records'); });
			const { embed, components } = await this.renderMembers(zoneRow);
			await interaction.editReply({ embeds: [embed], components }).catch(() => { });
		} catch (_err) {
			await interaction.followUp?.({ content: '❌ **Exclusion impossible**\n\nCe membre ne peut pas être exclu pour le moment. Vérifie qu\'il est toujours dans la zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			const { embed, components } = await this.renderMembers(zoneRow, memberId, { confirmKickFor: memberId });
			await interaction.editReply({ embeds: [embed], components }).catch(() => { });
		}
		return true;
	}

	if (parts[2] === 'kick-cancel') {
		const { embed, components } = await this.renderMembers(zoneRow, memberId);
		await interaction.update({ embeds: [embed], components }).catch(() => { });
		return true;
	}

	await interaction.deferUpdate().catch(() => { });
	return true;
}

module.exports = {
	_handleMemberSelect,
	_handleMemberButton,
};
