// Shared utility functions used across multiple services to avoid duplication

/**
 * Normalize a hex color string to #RRGGBB format.
 * @param {string} input - Color string (with or without #)
 * @returns {string|null} Normalized color or null if invalid
 */
function normalizeColor(input) {
	if (!input || typeof input !== 'string') return null;
	let hex = input.replace(/^#/, '').trim();
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null;
	return `#${hex.toUpperCase()}`;
}

/**
 * Check if a column exists in a table.
 * @param {import('mysql2/promise').Pool} db - Database pool
 * @param {string} table - Table name
 * @param {string} column - Column name
 * @returns {Promise<boolean>}
 */
async function columnExists(db, table, column) {
	const [rows] = await db.query(
		'SELECT 1 FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ? LIMIT 1',
		[table, column]
	);
	return rows.length > 0;
}

/**
 * Parse a comma-separated participant string into min/max integers.
 * @param {string} value - e.g. "2,10" or "5"
 * @returns {{ min: number|null, max: number|null }}
 */
function parseParticipants(value) {
	if (!value || typeof value !== 'string') return { min: null, max: null };
	const parts = value.split(',').map(s => s.trim());
	const min = parts[0] ? parseInt(parts[0], 10) : null;
	const max = parts[1] ? parseInt(parts[1], 10) : null;
	return {
		min: Number.isFinite(min) ? min : null,
		max: Number.isFinite(max) ? max : null
	};
}

/**
 * Format min/max participants into a display string.
 * @param {number|null} min
 * @param {number|null} max
 * @returns {string}
 */
function formatParticipants(min, max) {
	if (min && max) return `${min} - ${max}`;
	if (min) return `Min: ${min}`;
	if (max) return `Max: ${max}`;
	return 'Illimité';
}

/**
 * Extract the first image attachment from a Discord message.
 * @param {import('discord.js').Message} message
 * @returns {{ url: string, name: string }|null}
 */
function extractImageAttachment(message) {
	if (!message?.attachments?.size) return null;
	const img = [...message.attachments.values()].find(a =>
		a.contentType?.startsWith('image/') || /\.(png|jpe?g|gif|webp)$/i.test(a.name || '')
	);
	if (!img) return null;
	return { url: img.url, name: img.name || 'image.png' };
}

/**
 * Safe reply to a Discord interaction, handling deferred/replied state.
 * @param {import('discord.js').Interaction} interaction
 * @param {Object} payload - Reply payload
 */
async function safeReply(interaction, payload) {
	if (!interaction) return;
	try {
		if (!interaction.deferred && !interaction.replied) {
			await interaction.reply(payload);
		} else if (interaction.deferred) {
			await interaction.editReply(payload);
		} else {
			await interaction.followUp(payload);
		}
	} catch {
		// Interaction may have expired
	}
}

module.exports = {
	normalizeColor,
	columnExists,
	parseParticipants,
	formatParticipants,
	extractImageAttachment,
	safeReply
};
