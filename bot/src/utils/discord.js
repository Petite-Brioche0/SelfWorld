const { MessageFlags } = require('discord.js');

/**
 * Reply to an interaction regardless of its current state (deferred, replied, or fresh).
 * @param {import('discord.js').ChatInputCommandInteraction|import('discord.js').ButtonInteraction|import('discord.js').ModalSubmitInteraction} interaction
 * @param {string|object} payload - String content or full payload object
 * @param {object} [opts]
 * @param {import('pino').Logger} [opts.logger]
 */
async function safeReply(interaction, payload, { logger } = {}) {
	if (!interaction) return;
	const data = typeof payload === 'string'
		? { content: payload, flags: MessageFlags.Ephemeral }
		: payload;

	const handle = (err) => {
		if (err?.code === 10062 || err?.rawError?.code === 10062) return; // interaction expired
		logger?.warn({ err, userId: interaction.user?.id }, 'Failed to send interaction reply');
	};

	if (!interaction.deferred && !interaction.replied) {
		await interaction.reply(data).catch(handle);
	} else if (interaction.deferred && !interaction.replied) {
		// editReply does not accept flags
		const clean = { ...data };
		delete clean.flags;
		await interaction.editReply(clean).catch(handle);
	} else {
		await interaction.followUp(data).catch(handle);
	}
}

/**
 * Defer reply (ephemeral) if the interaction has not been deferred or replied to yet.
 * @param {import('discord.js').ChatInputCommandInteraction|import('discord.js').ButtonInteraction|import('discord.js').ModalSubmitInteraction} interaction
 * @param {object} [opts]
 * @param {number} [opts.flags] - Override flags (defaults to Ephemeral)
 * @param {import('pino').Logger} [opts.logger]
 */
async function safeDefer(interaction, { flags = MessageFlags.Ephemeral, logger } = {}) {
	if (!interaction || interaction.deferred || interaction.replied) return;
	await interaction.deferReply({ flags }).catch((err) => {
		if (err?.code === 10062 || err?.rawError?.code === 10062) return;
		logger?.warn({ err, userId: interaction.user?.id }, 'Failed to defer interaction');
	});
}

/**
 * Defer update (for button/select interactions) if not already deferred/replied.
 * @param {import('discord.js').ButtonInteraction|import('discord.js').StringSelectMenuInteraction} interaction
 * @param {object} [opts]
 * @param {import('pino').Logger} [opts.logger]
 */
async function safeDeferUpdate(interaction, { logger } = {}) {
	if (!interaction || interaction.deferred || interaction.replied) return;
	await interaction.deferUpdate().catch((err) => {
		if (err?.code === 10062 || err?.rawError?.code === 10062) return;
		logger?.warn({ err, userId: interaction.user?.id }, 'Failed to defer update');
	});
}

/**
 * Fetch a channel by ID, returning null on failure.
 * @param {import('discord.js').Client} client
 * @param {string} id
 * @returns {Promise<import('discord.js').Channel|null>}
 */
async function fetchChannel(client, id) {
	if (!id) return null;
	try { return await client.channels.fetch(id); } catch { return null; }
}

/**
 * Fetch a guild member by ID, returning null on failure.
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @returns {Promise<import('discord.js').GuildMember|null>}
 */
async function fetchMember(guild, userId) {
	if (!guild || !userId) return null;
	return guild.members.fetch(userId).catch(() => null);
}

module.exports = { safeReply, safeDefer, safeDeferUpdate, fetchChannel, fetchMember };
