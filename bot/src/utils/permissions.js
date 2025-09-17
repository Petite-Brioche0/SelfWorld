
const { ChannelType, PermissionFlagsBits } = require('discord.js');

/**
 * Apply strict isolation permissions for a zone category and its children.
 * - @everyone: no view
 * - zoneMemberRole: view/send in text, connect in voice
 * - zoneOwnerRole: same as member + manage channels on the category only
 * - global Owner (admin absolu) will inherit from guild role setup
 */
async function applyZoneOverwrites(category, { everyoneRole, zoneMemberRole, zoneOwnerRole }) {
	await category.permissionOverwrites.set([
		{ id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] },
		{ id: zoneMemberRole.id, allow: [PermissionFlagsBits.ViewChannel] },
		{ id: zoneOwnerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageChannels] },
	]);

	for (const ch of category.children.cache.values()) {
		if (ch.type === ChannelType.GuildText) {
			await ch.permissionOverwrites.set([
				{ id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] },
				{ id: zoneMemberRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
				{ id: zoneOwnerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
			]);
		}
		if (ch.type === ChannelType.GuildVoice) {
			await ch.permissionOverwrites.set([
				{ id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
				{ id: zoneMemberRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
				{ id: zoneOwnerRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak] },
			]);
		}
	}
}

module.exports = { applyZoneOverwrites };
