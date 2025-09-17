const { PermissionFlagsBits } = require('discord.js');

async function applyZonePermissions(category, { everyoneRoleId, ownerRoleId, memberRoleId, mutedRoleId, ownerUserId }) {
	const overwrites = [
		{
			id: everyoneRoleId,
			deny: [PermissionFlagsBits.ViewChannel]
		},
		{
			id: memberRoleId,
			allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.Connect, PermissionFlagsBits.Speak]
		},
		{
			id: ownerRoleId,
			allow: [
				PermissionFlagsBits.ViewChannel,
				PermissionFlagsBits.SendMessages,
				PermissionFlagsBits.Connect,
				PermissionFlagsBits.Speak,
				PermissionFlagsBits.ManageMessages,
				PermissionFlagsBits.MuteMembers
			]
		}
	];

	if (mutedRoleId) {
		overwrites.push({
			id: mutedRoleId,
			allow: [PermissionFlagsBits.ViewChannel],
			deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions, PermissionFlagsBits.Speak]
		});
	}

	if (ownerUserId) {
		overwrites.push({
			id: ownerUserId,
			allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageChannels]
		});
	}

	await category.permissionOverwrites.set(overwrites);

	for (const channel of category.children.cache.values()) {
		await channel.permissionOverwrites.set(overwrites);
	}
}

module.exports = {
	applyZonePermissions
};
