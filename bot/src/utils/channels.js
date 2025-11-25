const { ChannelType } = require('discord.js');
const db = require('./db');

async function fetchChannelById(guild, channelId) {
	if (!guild || !channelId) {
		return null;
	}

	const cached = guild.channels.cache.get(String(channelId));
	if (cached) {
		return cached;
	}

	try {
		return await guild.channels.fetch(String(channelId));
	} catch (err) {
		return null;
	}
}

async function ensureNotificationCategory(guild) {
	if (!guild?.channels) {
		throw new TypeError('ensureNotificationCategory nécessite une guilde valide');
	}

	await guild.channels.fetch();
	const existing = guild.channels.cache.find((channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase() === 'notification');
	if (existing) {
		return existing;
	}

	return guild.channels.create({
		name: 'Notification',
		type: ChannelType.GuildCategory,
		reason: 'Configuration automatique de la catégorie Notification'
	});
}

async function ensureTextChannel(guild, categoryId, name) {
	if (!guild?.channels) {
		throw new TypeError('ensureTextChannel nécessite une guilde valide');
	}

	if (!categoryId) {
		throw new TypeError('ensureTextChannel nécessite un identifiant de catégorie');
	}

	const normalizedName = String(name || '').trim().replace(/^#+/, '').toLowerCase();
	if (!normalizedName) {
		throw new TypeError('ensureTextChannel nécessite un nom de canal valide');
	}

	await guild.channels.fetch();
	const existing = guild.channels.cache.find(
		(channel) => channel.type === ChannelType.GuildText && channel.parentId === String(categoryId) && channel.name === normalizedName
	);
	if (existing) {
		return existing;
	}

	return guild.channels.create({
		name: normalizedName,
		type: ChannelType.GuildText,
		parent: String(categoryId),
		reason: 'Configuration automatique des canaux de notification'
	});
}

const FALLBACK_CONFIG = {
	welcome: { column: 'staff_announcements_channel_id', name: 'welcome' },
	requests: { column: 'requests_channel_id', name: 'requests' },
	'events-admin': { column: 'events_admin_channel_id', name: 'events-admin' }
};

async function ensureFallback(guild, kind) {
	if (!guild?.id) {
		throw new TypeError('ensureFallback nécessite une guilde valide');
	}

	const config = FALLBACK_CONFIG[kind];
	if (!config) {
		throw new RangeError(`Type de fallback inconnu : ${kind}`);
	}

	const settingsRows = await db.query('SELECT * FROM settings WHERE guild_id = :guildId LIMIT 1', { guildId: guild.id });
	const settings = settingsRows?.[0] || null;

	const storedChannelId = settings?.[config.column];
	if (storedChannelId) {
		const storedChannel = await fetchChannelById(guild, storedChannelId);
		if (storedChannel) {
			return storedChannel;
		}
	}

	const category = await ensureNotificationCategory(guild);
	const channel = await ensureTextChannel(guild, category.id, config.name);

	if (config.column) {
		await db.query(
			`INSERT INTO settings (guild_id, ${config.column}) VALUES (?, ?) ON DUPLICATE KEY UPDATE ${config.column} = VALUES(${config.column})`,
			[guild.id, channel.id]
		);
	}

	return channel;
}

module.exports = {
	ensureNotificationCategory,
	ensureTextChannel,
	ensureFallback
};
