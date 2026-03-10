// restore.js — Recreates deleted Discord resources and updates the DB.
// Functions receive `svc` (RepairService instance) which has client, db, logger.

const { ChannelType, PermissionFlagsBits } = require('discord.js');

// Maps DB field → channel name and type for zone core channels
const ZONE_CHANNEL_META = {
	text_panel_id:     { name: 'panel',          type: ChannelType.GuildText  },
	text_reception_id: { name: 'reception',       type: ChannelType.GuildText  },
	text_general_id:   { name: 'general',         type: ChannelType.GuildText  },
	text_anon_id:      { name: 'chuchotement',    type: ChannelType.GuildText  },
	voice_id:          { name: 'vocal',           type: ChannelType.GuildVoice }
};

// Maps DB field → role name prefix for zone core roles
const ZONE_ROLE_META = {
	role_owner_id:  (slug) => `O-${slug}`,
	role_member_id: (slug) => `M-${slug}`,
	role_muted_id:  (slug) => `Muted-${slug}`
};

/**
 * Recreates a deleted zone category and moves known zone channels back into it.
 */
async function restoreZoneCategory(svc, guild, zone) {
	const category = await guild.channels.create({
		name: `z-${zone.slug}`,
		type: ChannelType.GuildCategory,
		reason: `Repair: zone #${zone.id} category restored`
	});

	// Apply base permission: deny @everyone, allow bots
	await category.permissionOverwrites.set([
		{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
	]).catch(() => {});

	// Move orphaned zone channels into the new category
	const channelIds = [
		zone.text_panel_id, zone.text_reception_id, zone.text_general_id,
		zone.text_anon_id, zone.voice_id
	].filter(Boolean);

	for (const chId of channelIds) {
		const ch = await guild.channels.fetch(chId).catch(() => null);
		if (ch) {
			await ch.setParent(category.id, { lockPermissions: false }).catch(() => {});
		}
	}

	await svc.db.query(
		'UPDATE zones SET category_id = ? WHERE id = ?',
		[category.id, zone.id]
	);

	svc.logger?.info({ zoneId: zone.id, newCategoryId: category.id }, 'Zone category restored');
	return category;
}

/**
 * Recreates a deleted zone core channel (panel, reception, general, anon, voice).
 */
async function restoreZoneChannel(svc, guild, zone, field) {
	const meta = ZONE_CHANNEL_META[field];
	if (!meta) return null;

	const category = await guild.channels.fetch(zone.category_id).catch(() => null);

	const channel = await guild.channels.create({
		name: meta.name,
		type: meta.type,
		parent: category?.id ?? null,
		reason: `Repair: zone #${zone.id} channel "${meta.name}" restored`,
		...(category ? { lockPermissions: false } : {})
	});

	// Sync permissions with category if it exists
	if (category) {
		await channel.lockPermissions().catch(() => {});
	}

	await svc.db.query(
		`UPDATE zones SET ${field} = ? WHERE id = ?`,
		[channel.id, zone.id]
	);

	svc.logger?.info({ zoneId: zone.id, field, newChannelId: channel.id }, 'Zone channel restored');
	return channel;
}

/**
 * Recreates a deleted zone core role and reassigns it to existing zone members.
 */
async function restoreZoneRole(svc, guild, zone, field) {
	const nameFn = ZONE_ROLE_META[field];
	if (!nameFn) return null;

	const role = await guild.roles.create({
		name: nameFn(zone.slug),
		permissions: [],
		mentionable: false,
		reason: `Repair: zone #${zone.id} role "${nameFn(zone.slug)}" restored`
	});

	await svc.db.query(
		`UPDATE zones SET ${field} = ? WHERE id = ?`,
		[role.id, zone.id]
	);

	// Reassign role to all current zone members
	const roleType = field === 'role_owner_id' ? 'owner' : (field === 'role_member_id' ? 'member' : null);
	if (roleType) {
		const whereClause = roleType === 'owner'
			? 'WHERE zone_id = ? AND role = "owner"'
			: 'WHERE zone_id = ?';
		const [members] = await svc.db.query(
			`SELECT user_id FROM zone_members ${whereClause}`,
			[zone.id]
		);
		for (const { user_id } of members) {
			const member = await guild.members.fetch(user_id).catch(() => null);
			if (member) await member.roles.add(role).catch(() => {});
		}
	}

	svc.logger?.info({ zoneId: zone.id, field, newRoleId: role.id }, 'Zone role restored');
	return role;
}

/**
 * Recreates a deleted zone custom role (no auto-reassignment).
 */
async function restoreZoneCustomRole(svc, guild, zoneId, roleName, oldRoleId) {
	const role = await guild.roles.create({
		name: roleName,
		permissions: [],
		mentionable: false,
		reason: `Repair: zone #${zoneId} custom role "${roleName}" restored`
	});

	await svc.db.query(
		'UPDATE zone_roles SET role_id = ? WHERE zone_id = ? AND role_id = ?',
		[role.id, zoneId, oldRoleId]
	);

	svc.logger?.info({ zoneId, oldRoleId, newRoleId: role.id }, 'Zone custom role restored');
	return role;
}

/**
 * Clears a missing settings channel column and notifies the admin to reconfigure.
 */
async function clearSettingsChannel(svc, guildId, column) {
	await svc.db.query(
		`UPDATE settings SET ${column} = NULL WHERE guild_id = ?`,
		[guildId]
	);
	svc.logger?.info({ guildId, column }, 'Cleared missing settings channel');
}

module.exports = {
	restoreZoneCategory,
	restoreZoneChannel,
	restoreZoneRole,
	restoreZoneCustomRole,
	clearSettingsChannel
};
