// detect.js — Queries the DB to identify what a deleted Discord resource was.
// All column names are hardcoded strings, never user input — template literals are safe.

const ZONE_CHANNEL_FIELDS = [
	'category_id',
	'text_panel_id',
	'text_reception_id',
	'text_general_id',
	'text_anon_id',
	'voice_id'
];

const SETTINGS_CHANNEL_COLUMNS = [
	'anon_admin_channel_id',
	'requests_channel_id',
	'events_admin_channel_id',
	'journal_channel_id'
];

const ZONE_ROLE_FIELDS = ['role_owner_id', 'role_member_id', 'role_muted_id'];

/**
 * Checks whether a deleted channelId was managed by the bot.
 * @returns {object|null} Detection result or null if unmanaged
 */
async function detectChannel(db, channelId) {
	// ── Zone channels / category ─────────────────────────────────────────────
	for (const field of ZONE_CHANNEL_FIELDS) {
		const [rows] = await db.query(
			`SELECT id, guild_id, name, slug, category_id,
			        text_panel_id, text_reception_id, text_general_id, text_anon_id, voice_id,
			        role_owner_id, role_member_id
			 FROM zones WHERE ${field} = ?`,
			[channelId]
		);
		if (rows[0]) {
			return {
				type: field === 'category_id' ? 'zone_category' : 'zone_channel',
				field,
				zoneId: rows[0].id,
				guildId: rows[0].guild_id,
				zone: rows[0]
			};
		}
	}

	// ── Settings channels ────────────────────────────────────────────────────
	for (const col of SETTINGS_CHANNEL_COLUMNS) {
		const [rows] = await db.query(
			`SELECT guild_id FROM settings WHERE ${col} = ?`,
			[channelId]
		);
		if (rows[0]) {
			return { type: 'settings_channel', column: col, guildId: rows[0].guild_id };
		}
	}

	// ── Setup channel ────────────────────────────────────────────────────────
	const [setupRows] = await db.query(
		'SELECT guild_id FROM settings WHERE setup_channel_id = ?',
		[channelId]
	);
	if (setupRows[0]) {
		return { type: 'setup_channel', guildId: setupRows[0].guild_id };
	}

	return null;
}

/**
 * Checks whether a deleted roleId was managed by the bot.
 * @returns {object|null} Detection result or null if unmanaged
 */
async function detectRole(db, roleId) {
	// ── Zone core roles ──────────────────────────────────────────────────────
	for (const field of ZONE_ROLE_FIELDS) {
		const [rows] = await db.query(
			`SELECT id, guild_id, name, slug, category_id FROM zones WHERE ${field} = ?`,
			[roleId]
		);
		if (rows[0]) {
			return {
				type: 'zone_role',
				field,
				zoneId: rows[0].id,
				guildId: rows[0].guild_id,
				zone: rows[0],
				roleId
			};
		}
	}

	// ── Zone custom roles ────────────────────────────────────────────────────
	const [customRoles] = await db.query(
		`SELECT zr.zone_id, zr.name AS role_name, z.guild_id
		 FROM zone_roles zr
		 JOIN zones z ON z.id = zr.zone_id
		 WHERE zr.role_id = ?`,
		[roleId]
	);
	if (customRoles[0]) {
		return {
			type: 'zone_custom_role',
			zoneId: customRoles[0].zone_id,
			guildId: customRoles[0].guild_id,
			roleName: customRoles[0].role_name,
			roleId
		};
	}

	return null;
}

/**
 * Checks whether a deleted messageId was managed by the bot.
 * @returns {object|null} Detection result or null if unmanaged
 */
async function detectMessage(db, messageId) {
	const [rows] = await db.query(
		'SELECT guild_id FROM settings WHERE setup_message_id = ?',
		[messageId]
	);
	if (rows[0]) {
		return { type: 'setup_message', guildId: rows[0].guild_id };
	}
	return null;
}

module.exports = { detectChannel, detectRole, detectMessage };
