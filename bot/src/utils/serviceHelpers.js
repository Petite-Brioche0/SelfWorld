// Shared utility functions used across multiple services to avoid duplication

/**
 * Normalize a hex color string to #RRGGBB format.
 * @param {string} input - Color string (with or without #)
 * @returns {string|null} Normalized color or null if invalid
 */
function normalizeColor(input) {
	if (!input) return null;
	const trimmed = String(input).trim().replace(/^#/, '');
	if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
	return `#${trimmed.toUpperCase()}`;
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
		`SELECT COUNT(*) AS n
		 FROM information_schema.COLUMNS
		 WHERE TABLE_SCHEMA = DATABASE()
		   AND TABLE_NAME = ?
		   AND COLUMN_NAME = ?`,
		[table, column]
	);
	return Number(rows?.[0]?.n || 0) > 0;
}

/**
 * Parse a participant string into min/max integers.
 * Supports formats: "min=X max=Y", "X/Y", or a single number (treated as max).
 * @param {string} raw - Participant string
 * @returns {{ min: number|null, max: number|null }}
 */
function parseParticipants(raw) {
	const value = String(raw || '').trim();
	if (!value) return { min: null, max: null };

	let min = null;
	let max = null;

	const minMatch = value.match(/min\s*=\s*(\d+)/i);
	const maxMatch = value.match(/max\s*=\s*(\d+)/i);
	if (minMatch) min = Number(minMatch[1]);
	if (maxMatch) max = Number(maxMatch[1]);

	if (!minMatch && !maxMatch) {
		const pairMatch = value.match(/(\d+)\s*\/\s*(\d+)/);
		if (pairMatch) {
			min = Number(pairMatch[1]);
			max = Number(pairMatch[2]);
		} else if (/^\d+$/.test(value)) {
			max = Number(value);
		}
	}

	if (min && max && min > max) {
		[min, max] = [max, min];
	}

	return {
		min: Number.isFinite(min) && min > 0 ? min : null,
		max: Number.isFinite(max) && max > 0 ? max : null
	};
}

/**
 * Format min/max participants from a record into a display string.
 * @param {{ min_participants?: number, max_participants?: number }|null} existing - Record with participant fields
 * @returns {string}
 */
function formatParticipants(existing) {
	if (!existing) return '';
	const min = existing.min_participants ? Number(existing.min_participants) : null;
	const max = existing.max_participants ? Number(existing.max_participants) : null;
	if (!min && !max) return '';
	if (min && max) return `min=${min} max=${max}`;
	if (min) return `min=${min}`;
	return `max=${max}`;
}

/**
 * Extract the first image attachment from a Discord message.
 * Returns the raw attachment object for maximum flexibility.
 * @param {import('discord.js').Message} message
 * @returns {import('discord.js').Attachment|null}
 */
function extractImageAttachment(message) {
	const attachments = message?.attachments ? [...message.attachments.values()] : [];
	for (const attachment of attachments) {
		if (attachment?.contentType?.startsWith?.('image/')) return attachment;
		if (attachment?.url && /\.(png|jpe?g|gif|webp)$/i.test(attachment.url)) return attachment;
	}
	return null;
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
