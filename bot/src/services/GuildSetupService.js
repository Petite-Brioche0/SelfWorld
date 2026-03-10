const {
	ChannelType,
	PermissionFlagsBits,
	ChannelSelectMenuBuilder,
	ActionRowBuilder,
	MessageFlags
} = require('discord.js');
const { buildSetupPanel, buildExplanationPayloads, SETUP_STEPS } = require('./setup/panel');

// Maps button customId → settings column
const CONFIGURE_MAP = {
	'setup:configure:anon': 'anon_admin_channel_id',
	'setup:configure:requests': 'requests_channel_id',
	'setup:configure:events': 'events_admin_channel_id',
	'setup:configure:journal': 'journal_channel_id'
};

// Maps channel-select customId → settings column
const SELECT_MAP = {
	'setup:select:anon': 'anon_admin_channel_id',
	'setup:select:requests': 'requests_channel_id',
	'setup:select:events': 'events_admin_channel_id',
	'setup:select:journal': 'journal_channel_id'
};

// Maps button customId → channel-select customId
const BUTTON_TO_SELECT = {
	'setup:configure:anon': 'setup:select:anon',
	'setup:configure:requests': 'setup:select:requests',
	'setup:configure:events': 'setup:select:events',
	'setup:configure:journal': 'setup:select:journal'
};

// Maps settings column → human label (for the ephemeral selector prompt)
const STEP_LABEL = Object.fromEntries(SETUP_STEPS.map((s) => [s.key, s.label]));

class GuildSetupService {
	constructor(client, db, logger) {
		this.client = client;
		this.db = db;
		this.logger = logger;
	}

	// ─── guildCreate entry point ──────────────────────────────────────────────

	/**
	 * Called when the bot joins a new guild.
	 * Delegates to ensureSetupChannel — skipped if the channel still exists.
	 */
	async onGuildCreate(guild) {
		await this.ensureSetupChannel(guild);
	}

	// ─── Public: ensure setup channel exists ──────────────────────────────────

	/**
	 * Ensures the setup channel exists for this guild.
	 * - If it exists on Discord → returns { channel, isNew: false }
	 * - If it was deleted or never created → creates a new one with all messages
	 *   and returns { channel, isNew: true }
	 *
	 * Safe to call at any time (e.g. from /setup command).
	 */
	async ensureSetupChannel(guild) {
		const existing = await this.#getSettings(guild.id);

		if (existing?.setup_channel_id) {
			const ch = await guild.channels.fetch(existing.setup_channel_id).catch(() => null);
			if (ch) return { channel: ch, isNew: false };
		}

		// Channel missing or never created — build a fresh one
		const setupChannel = await guild.channels.create({
			name: 'configuration-bot',
			type: ChannelType.GuildText,
			topic: '🛠️ Salon de configuration du bot — peut être supprimé une fois terminé.',
			permissionOverwrites: [
				{
					id: guild.roles.everyone.id,
					deny: [PermissionFlagsBits.ViewChannel]
				}
			]
		});

		// Static explanation messages (never edited)
		for (const payload of buildExplanationPayloads()) {
			await setupChannel.send(payload);
		}

		// Interactive panel (edited as settings are configured)
		const msg = await setupChannel.send(buildSetupPanel(existing));

		// Upsert settings with the new channel + message IDs
		await this.db.query(
			`INSERT INTO settings (guild_id, setup_channel_id, setup_message_id, created_at)
			 VALUES (?, ?, ?, NOW())
			 AS new
			 ON DUPLICATE KEY UPDATE
			   setup_channel_id = new.setup_channel_id,
			   setup_message_id = new.setup_message_id`,
			[guild.id, setupChannel.id, msg.id]
		);

		this.logger?.info({ guildId: guild.id, channelId: setupChannel.id }, 'Setup channel created');
		return { channel: setupChannel, isNew: true };
	}

	// ─── Button handler ───────────────────────────────────────────────────────

	/**
	 * Handles setup:configure:* button clicks.
	 * Sends an ephemeral channel selector to the clicking admin.
	 */
	async handleButton(interaction) {
		const id = interaction.customId;
		const column = CONFIGURE_MAP[id];
		if (!column) return false;

		// Only guild owner or admins
		if (!this.#isAdmin(interaction)) {
			return interaction.reply({
				content: '🔒 **Accès restreint**\n\nSeuls les administrateurs peuvent configurer le bot.',
				flags: MessageFlags.Ephemeral
			});
		}

		const step = SETUP_STEPS.find((s) => s.key === column);
		const selectId = BUTTON_TO_SELECT[id];

		const select = new ChannelSelectMenuBuilder()
			.setCustomId(selectId)
			.setPlaceholder(`Sélectionner un salon pour : ${step?.label ?? column}`)
			.addChannelTypes(ChannelType.GuildText);

		const row = new ActionRowBuilder().addComponents(select);

		return interaction.reply({
			content: `**${step?.label ?? column}**\n${step?.description ?? ''}\n\nChoisissez le salon à utiliser :`,
			components: [row],
			flags: MessageFlags.Ephemeral
		});
	}

	// ─── Channel select handler ───────────────────────────────────────────────

	/**
	 * Handles setup:select:* channel select menu submissions.
	 * Saves the chosen channel ID and refreshes the setup panel.
	 */
	async handleChannelSelect(interaction) {
		const id = interaction.customId;
		const column = SELECT_MAP[id];
		if (!column) return false;

		if (!this.#isAdmin(interaction)) {
			return interaction.reply({
				content: '🔒 **Accès restreint**\n\nSeuls les administrateurs peuvent configurer le bot.',
				flags: MessageFlags.Ephemeral
			});
		}

		const channelId = interaction.values[0];
		const guildId = interaction.guildId;

		// Save to settings
		await this.db.query(
			`INSERT INTO settings (guild_id, ${column}, created_at)
			 VALUES (?, ?, NOW())
			 AS new
			 ON DUPLICATE KEY UPDATE ${column} = new.${column}`,
			[guildId, channelId]
		);

		this.logger?.info({ guildId, column, channelId }, 'Setup setting saved');

		// Acknowledge ephemeral selector
		await interaction.update({ content: '✅ Salon enregistré.', components: [] });

		// Refresh the main setup panel
		await this.#refreshPanel(guildId);

		return true;
	}

	// ─── Private helpers ──────────────────────────────────────────────────────

	async #getSettings(guildId) {
		const [rows] = await this.db.query('SELECT * FROM settings WHERE guild_id = ?', [guildId]);
		return rows?.[0] ?? null;
	}

	/**
	 * Fetches current settings and edits the setup panel message in place.
	 */
	async #refreshPanel(guildId) {
		const settings = await this.#getSettings(guildId);
		if (!settings?.setup_channel_id || !settings?.setup_message_id) return;

		try {
			const guild = await this.client.guilds.fetch(guildId);
			const channel = await guild.channels.fetch(settings.setup_channel_id).catch(() => null);
			if (!channel) return;

			const msg = await channel.messages.fetch(settings.setup_message_id).catch(() => null);
			if (!msg) return;

			const payload = buildSetupPanel(settings);
			await msg.edit(payload);
		} catch (err) {
			this.logger?.warn({ err, guildId }, 'Failed to refresh setup panel');
		}
	}

	/**
	 * Returns true if the member is guild owner or has Administrator permission.
	 */
	#isAdmin(interaction) {
		if (!interaction.inGuild()) return false;
		if (interaction.guild?.ownerId === interaction.user.id) return true;
		return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ?? false;
	}
}

module.exports = { GuildSetupService, STEP_LABEL };
