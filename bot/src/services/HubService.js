// Hub system: welcomes new members, creates channels, and sends panels
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	MessageFlags,
	PermissionFlagsBits,
} = require('discord.js');
const { shortId } = require('../utils/ids');
const { extractImageAttachment } = require('../utils/serviceHelpers');

const requests = require('./hub/requests');
const builders = require('./hub/builders');

const DEFAULT_COLOR = 0x5865f2;
const HUB_CATEGORY_NAMES = ['hub', 'onboarding'];
const HUB_TOPIC = 'Hub - panneaux prives';

class HubService {
	#schemaReady = false;
	#processing = false;

	constructor(client, db, logger = null, services = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
		this.services = services || null;
		this.pendingImages = new Map();
	}

	/** @param {object} services - Service registry injected after construction */
	setServices(services) {
		this.services = services || null;
	}

	/** Creates hub_channels and hub_requests tables if they don't exist. Idempotent. */
	async ensureSchema() {
		if (this.#schemaReady) return;

		await this.db.query(`CREATE TABLE IF NOT EXISTS hub_channels (
                        guild_id VARCHAR(32) NOT NULL,
                        user_id VARCHAR(32) NOT NULL,
                        channel_id VARCHAR(32) NOT NULL,
                        join_message_id VARCHAR(32) NULL,
                        request_message_id VARCHAR(32) NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY (guild_id, user_id),
                        UNIQUE KEY uniq_channel (channel_id)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch(() => {
                        // Expected failure if table already exists - intentionally silent
                });

		await this.db.query(`CREATE TABLE IF NOT EXISTS hub_requests (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        guild_id VARCHAR(32) NOT NULL,
                        user_id VARCHAR(32) NOT NULL,
                        kind ENUM('announcement','event') NOT NULL,
                        status ENUM('draft','pending','accepted','denied') NOT NULL DEFAULT 'draft',
                        content TEXT NULL,
                        embed_title VARCHAR(256) NULL,
                        embed_description TEXT NULL,
                        embed_color VARCHAR(7) NULL,
                        embed_image VARCHAR(500) NULL,
                        message_content TEXT NULL,
                        game VARCHAR(120) NULL,
                        min_participants INT NULL,
                        max_participants INT NULL,
                        scheduled_at DATETIME NULL,
                        preview_channel_id VARCHAR(32) NULL,
                        preview_message_id VARCHAR(32) NULL,
                        review_channel_id VARCHAR(32) NULL,
                        review_message_id VARCHAR(32) NULL,
                        decided_by VARCHAR(32) NULL,
                        decided_at DATETIME NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        updated_at TIMESTAMP NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch(() => {
                        // Expected failure if table already exists - intentionally silent
                });

		this.#schemaReady = true;
	}

	/** Ensures hub channels exist for every non-bot member across all cached guilds. Guards against concurrent runs. */
	async ensureAllHubChannels() {
		if (this.#processing) return;
		this.#processing = true;
		try {
			for (const guild of this.client.guilds.cache.values()) {
				await this.ensureHubChannelsForGuild(guild).catch((err) => {
					this.logger?.warn({ err, guildId: guild.id }, 'Failed to ensure hub channels for guild');
				});
			}
		} finally {
			this.#processing = false;
		}
	}

	/**
	 * Ensures hub channels exist for every non-bot member of a single guild.
	 * @param {import('discord.js').Guild} guild
	 */
	async ensureHubChannelsForGuild(guild) {
		if (!guild) return;
		await this.ensureSchema();

		let members = null;
		try {
			members = await guild.members.fetch();
		} catch (err) {
			this.logger?.warn({ err, guildId: guild.id }, 'Failed to fetch guild members for hub');
			return;
		}

		const channelIndex = await this._buildHubChannelIndex(guild);

		for (const member of members.values()) {
			if (member.user?.bot) continue;
			await this.ensureHubChannelForMember(member, channelIndex).catch((err) => {
				this.logger?.warn({ err, guildId: guild.id, userId: member.id }, 'Failed to ensure hub channel');
			});
			await this._sleep(350);
		}
	}

	/**
	 * Creates or updates the private hub channel for a single member, sending join and request panel messages.
	 * @param {import('discord.js').GuildMember} member
	 * @param {Map<string, import('discord.js').TextChannel>|null} [channelIndex] - Pre-built channel index for batch operations
	 * @returns {Promise<import('discord.js').TextChannel|null>}
	 */
	async ensureHubChannelForMember(member, channelIndex = null) {
		if (!member || member.user?.bot) return null;
		await this.ensureSchema();

		const guild = member.guild;
		const guildId = guild.id;

		let record = await this._getHubRecord(guildId, member.id);
		let channel = record?.channel_id ? await this._fetchChannel(record.channel_id) : null;

		if (!channel) {
			channel = channelIndex?.get?.(member.id) || null;
		}
		if (!channel) {
			channel = await this._findExistingHubChannel(guild, member.id);
		}

		if (!channel) {
			const category = await this._ensureHubCategory(guild);
			const channelName = `hub-${shortId(6)}`;
			const botId = guild.members.me?.id || this.client.user.id;

			const overwrites = [
				{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
				{
					id: member.id,
					allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
				},
				{
					id: botId,
					allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
				}
			];

			channel = await guild.channels.create({
				name: channelName,
				type: ChannelType.GuildText,
				parent: category?.id,
				reason: 'Hub channel',
				permissionOverwrites: overwrites,
				topic: HUB_TOPIC
			}).catch(() => null);
		}

		if (!channel) return null;

		const desiredTopic = HUB_TOPIC;
		if (channel.topic !== desiredTopic) {
			channel.setTopic(desiredTopic).catch((err) => {
				this.logger?.warn({ err, channelId: channel?.id }, 'Failed to set hub channel topic');
			});
		}

		const joinMessageId = await this._upsertPanelMessage(
			channel,
			record?.join_message_id || null,
			this._buildJoinPanelPayload(guildId)
		);
		const requestMessageId = await this._upsertPanelMessage(
			channel,
			record?.request_message_id || null,
			this._buildRequestPanelPayload()
		);

		record = await this._setHubRecord(guildId, member.id, channel.id, joinMessageId, requestMessageId);
		return channel;
	}

	/**
	 * Routes hub button interactions (announce/event creation, request submit/edit/accept/deny).
	 * @param {import('discord.js').ButtonInteraction} interaction
	 * @returns {Promise<boolean>} true if the interaction was handled
	 */
	async handleButton(interaction) {
		const id = interaction?.customId || '';
		if (!id.startsWith('hub:')) return false;

		await this.ensureSchema();

		if (id === 'hub:announce:new') {
			const modal = this._buildAnnouncementModal(null, { title: 'Demander une annonce' });
			await interaction.showModal(modal);
			return true;
		}

		if (id === 'hub:event:new') {
			const modal = this._buildEventModal(null, { title: 'Demander un événement' });
			await interaction.showModal(modal);
			return true;
		}

		let match = id.match(/^hub:req:edit:(\d+)/);
		if (match) {
			const requestId = Number(match[1]);
			const request = await this._getRequest(requestId);
			if (!request) {
				await this._reply(interaction, {
					content: '❌ **Demande introuvable**\n\nCette demande n\'existe plus ou a été supprimée.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (request.user_id !== interaction.user.id) {
				await this._reply(interaction, {
					content: '🚫 **Action non autorisée**\n\nTu ne peux modifier que tes propres demandes.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (request.status !== 'draft') {
				await this._reply(interaction, {
					content: '⚠️ **Demande déjà envoyée**\n\nCette demande a déjà été soumise à la modération et ne peut plus être modifiée.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (request.kind === 'announcement') {
				const modal = this._buildAnnouncementModal(request, { title: 'Modifier une annonce' });
				await interaction.showModal(modal);
				return true;
			}
			const modal = this._buildEventModal(request, { title: 'Modifier un événement' });
			await interaction.showModal(modal);
			return true;
		}

		match = id.match(/^hub:req:schedule:(\d+)/);
		if (match) {
			const requestId = Number(match[1]);
			const request = await this._getRequest(requestId);
			if (!request) {
				await this._reply(interaction, {
					content: '❌ **Demande introuvable**\n\nCette demande n\'existe plus ou a été supprimée.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (request.user_id !== interaction.user.id) {
				await this._reply(interaction, {
					content: '🚫 **Action non autorisée**\n\nTu ne peux programmer que tes propres demandes.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (request.status !== 'draft') {
				await this._reply(interaction, {
					content: '⚠️ **Demande déjà envoyée**\n\nCette demande a déjà été soumise et ne peut plus être programmée.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			const modal = this._buildScheduleModal(request);
			await interaction.showModal(modal);
			return true;
		}

		match = id.match(/^hub:req:submit:(\d+)/);
		if (match) {
			await this._deferReply(interaction);
			const requestId = Number(match[1]);
			const request = await this._getRequest(requestId);
			if (!request) {
				await this._reply(interaction, {
					content: '❌ **Demande introuvable**\n\nCette demande n\'existe plus ou a été supprimée.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (request.user_id !== interaction.user.id) {
				await this._reply(interaction, {
					content: '🚫 **Action non autorisée**\n\nTu ne peux envoyer que tes propres demandes.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (request.status !== 'draft') {
				await this._reply(interaction, {
					content: '⚠️ **Demande déjà envoyée**\n\nCette demande a déjà été transmise à la modération.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}

			await this._updateRequest(request.id, { status: 'pending' });
			const updated = await this._getRequest(request.id);
			await this._deliverRequest(updated);
			await this._disablePreviewMessage(updated, '📤 En attente de validation');
			await this._reply(interaction, {
				content: '✅ **Demande envoyée !**\n\n' +
					'Ta demande a été transmise à l\'équipe de modération. ' +
					'Tu recevras une notification dès qu\'elle sera examinée.\n\n' +
					'> 💡 *La validation peut prendre quelques heures.*',
				flags: MessageFlags.Ephemeral
			});
			return true;
		}

		match = id.match(/^hub:req:(deny|accept|editaccept):(\d+)/);
		if (match) {
			const action = match[1];
			const requestId = Number(match[2]);
			if (!this._isOwner(interaction)) {
				await this._reply(interaction, {
					content: '👑 **Modération uniquement**\n\nCette action est réservée à l\'équipe de modération.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			const request = await this._getRequest(requestId);
			if (!request) {
				await this._reply(interaction, {
					content: '❌ **Demande introuvable**\n\nCette demande n\'existe plus ou a été supprimée.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (request.status !== 'pending') {
				await this._reply(interaction, {
					content: '⚠️ **Demande déjà traitée**\n\nCette demande a déjà été acceptée ou refusée.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (action === 'deny') {
				await this._deferReply(interaction);
				await this._denyRequest(request, interaction.user.id);
				await this._reply(interaction, {
					content: '❌ **Demande refusée**\n\nLa demande a été refusée et l\'utilisateur a été notifié.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (action === 'accept') {
				await this._deferReply(interaction);
				const result = await this._acceptRequest(request, interaction.user.id);
				if (!result.ok) {
					await this._reply(interaction, {
						content: `❌ **Erreur**\n\n${result.message || 'Impossible d\'accepter cette demande.'}`,
						flags: MessageFlags.Ephemeral
					});
					return true;
				}
				await this._reply(interaction, {
					content: '✅ **Demande acceptée**\n\nLa demande a été acceptée et publiée. L\'utilisateur a été notifié.',
					flags: MessageFlags.Ephemeral
				});
				return true;
			}
			if (action === 'editaccept') {
				const modal = this._buildEditAcceptModal(request);
				await interaction.showModal(modal);
				return true;
			}
		}

		await this._reply(interaction, { content: 'Action inconnue.', flags: MessageFlags.Ephemeral });
		return true;
	}

	/**
	 * Routes hub modal submissions (announcement/event creation, scheduling, edit-accept).
	 * @param {import('discord.js').ModalSubmitInteraction} interaction
	 * @returns {Promise<boolean>} true if the interaction was handled
	 */
	async handleModal(interaction) {
		const id = interaction?.customId || '';
		if (!id.startsWith('hub:')) return false;

		await this.ensureSchema();

		if (id.startsWith('hub:announce:modal')) {
			await this._handleAnnouncementModal(interaction);
			return true;
		}

		if (id.startsWith('hub:event:modal')) {
			await this._handleEventModal(interaction);
			return true;
		}

		let match = id.match(/^hub:req:schedule:modal:(\d+)/);
		if (match) {
			const requestId = Number(match[1]);
			const request = await this._getRequest(requestId);
			if (!request) {
				await this._reply(interaction, { content: 'Demande introuvable.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.user_id !== interaction.user.id) {
				await this._reply(interaction, { content: 'Action non autorisée.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.status !== 'draft') {
				await this._reply(interaction, { content: 'Demande déjà envoyée.', flags: MessageFlags.Ephemeral });
				return true;
			}
			await this._handleScheduleModal(interaction, request);
			return true;
		}

		match = id.match(/^hub:req:editaccept:modal:(\d+)/);
		if (match) {
			const requestId = Number(match[1]);
			const request = await this._getRequest(requestId);
			if (!request) {
				await this._reply(interaction, { content: 'Demande introuvable.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (!this._isOwner(interaction)) {
				await this._reply(interaction, { content: 'Action reservee à Brioche.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.status !== 'pending') {
				await this._reply(interaction, { content: 'Demande déjà traitée.', flags: MessageFlags.Ephemeral });
				return true;
			}
			await this._handleEditAcceptModal(interaction, request);
			return true;
		}

		return false;
	}

	/**
	 * Handles a message that may contain a pending image upload for a hub request.
	 * Attaches the image to the request and updates the preview.
	 * @param {import('discord.js').Message} message
	 * @returns {Promise<boolean>} true if the message was consumed as a pending image
	 */
	async consumeImageMessage(message) {
		if (!message?.guild || message.author?.bot) return false;
		const key = `${message.guild.id}:${message.author.id}`;
		const pending = this.pendingImages.get(key);
		if (!pending) return false;
		if (pending.channelId && pending.channelId !== message.channel.id) return false;

		const ageMs = Date.now() - pending.requestedAt;
		if (ageMs > 10 * 60 * 1000) {
			this.pendingImages.delete(key);
			return false;
		}

		const attachment = extractImageAttachment(message);
		if (!attachment) {
			await message.reply('❌ **Fichier non valide**\n\nMerci d\'envoyer une **image** (formats acceptés : PNG, JPG, GIF, WEBP).').catch((err) => {
				if (err?.code === 10008) return; // Unknown message
				this.logger?.warn({ err, messageId: message?.id }, 'Failed to send invalid file error to user');
			});
			return true;
		}

		this.pendingImages.delete(key);
		await this.ensureSchema();

		try {
			await this._updateRequest(pending.recordId, { embed_image: attachment.url });
			const request = await this._getRequest(pending.recordId);
			if (request) {
				await this._upsertPreviewMessage(request);
				await message.reply('✅ **Image ajoutée avec succès !**\n\nTon aperçu a été mis à jour avec l\'image. Tu peux maintenant envoyer ta demande.').catch((err) => {
					if (err?.code === 10008) return; // Unknown message
					this.logger?.warn({ err, messageId: message?.id }, 'Failed to send image success confirmation');
				});
			}
			return true;
		} catch (err) {
			this.logger?.warn({ err, recordId: pending.recordId }, 'Failed to attach image to hub request');
			await message.reply('❌ **Erreur**\n\nImpossible de récupérer cette image pour le moment. Réessaye avec une autre image.').catch((err) => {
				if (err?.code === 10008) return; // Unknown message
				this.logger?.warn({ err, messageId: message?.id }, 'Failed to send image error message');
			});
			return true;
		}
	}

	// ===== Infrastructure helpers =====

	async _fetchChannel(id) {
		if (!id) return null;
		try {
			return await this.client.channels.fetch(id);
		} catch {
			return null;
		}
	}

	async _sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	_getOwnerId() {
		return this.client?.context?.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID || null;
	}

	_isOwner(interaction) {
		const ownerId = this._getOwnerId();
		return ownerId && String(interaction.user.id) === String(ownerId);
	}

	async _reply(interaction, payload) {
		if (!interaction) return;
		if (!interaction.deferred && !interaction.replied) {
			await interaction.reply(payload);
		} else if (interaction.deferred && !interaction.replied) {
			const clean = { ...payload };
			if ('flags' in clean) delete clean.flags;
			await interaction.editReply(clean);
		} else {
			await interaction.followUp(payload);
		}
	}

	async _deferReply(interaction) {
		if (!interaction || interaction.deferred || interaction.replied) return;
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		} catch { /* ignored */ }
	}

	async _notifyUser(userId, payload) {
		if (!payload) return;
		const ownerId = this._getOwnerId();
		if (!ownerId || !userId || String(ownerId) !== String(userId)) return;
		try {
			const user = await this.client.users.fetch(userId);
			await user.send(payload).catch((err) => {
				this.logger?.warn({ err, userId }, 'Failed to send DM notification to owner');
			});
		} catch (err) {
			this.logger?.warn({ err, userId }, 'Failed to fetch user for DM notification');
		}
	}

	async _getRequestsChannelId(guildId) {
		if (!guildId) return null;
		const [rows] = await this.db.query('SELECT requests_channel_id FROM settings WHERE guild_id = ?', [guildId]);
		const configured = rows?.[0]?.requests_channel_id;
		return configured || process.env.ZONE_REQUESTS_CHANNEL_ID || null;
	}

	// ===== DB helpers — hub_channels =====

	async _getHubRecord(guildId, userId) {
		const [rows] = await this.db.query(
			'SELECT * FROM hub_channels WHERE guild_id = ? AND user_id = ?',
			[guildId, userId]
		);
		return rows?.[0] || null;
	}

	async _setHubRecord(guildId, userId, channelId, joinMessageId, requestMessageId) {
		await this.db.query(
			`INSERT INTO hub_channels (guild_id, user_id, channel_id, join_message_id, request_message_id)
                         VALUES (?, ?, ?, ?, ?) AS new
                         ON DUPLICATE KEY UPDATE channel_id = new.channel_id,
                                 join_message_id = new.join_message_id,
                                 request_message_id = new.request_message_id`,
			[guildId, userId, channelId, joinMessageId, requestMessageId]
		);
		return this._getHubRecord(guildId, userId);
	}

	// ===== DB helpers — hub_requests =====

	async _insertRequest(payload) {
		const [res] = await this.db.query(
			`INSERT INTO hub_requests
                         (guild_id, user_id, kind, status, content, embed_title, embed_description, embed_color, embed_image,
                          message_content, game, min_participants, max_participants, scheduled_at, preview_channel_id, preview_message_id, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NOW())`,
			[
				payload.guild_id,
				payload.user_id,
				payload.kind,
				payload.status || 'draft',
				payload.content || null,
				payload.embed_title || null,
				payload.embed_description || null,
				payload.embed_color || null,
				payload.embed_image || null,
				payload.message_content || null,
				payload.game || null,
				payload.min_participants || null,
				payload.max_participants || null,
				payload.scheduled_at || null
			]
		);
		return res.insertId;
	}

	async _updateRequest(id, updates) {
		if (!id) return;
		const ALLOWED_COLUMNS = new Set([
			'status', 'content', 'embed_title', 'embed_description', 'embed_color',
			'embed_image', 'message_content', 'game', 'min_participants', 'max_participants',
			'scheduled_at', 'preview_channel_id', 'preview_message_id', 'review_channel_id',
			'review_message_id', 'decided_by', 'decided_at'
		]);
		const fields = [];
		const values = [];
		for (const [key, value] of Object.entries(updates || {})) {
			if (!ALLOWED_COLUMNS.has(key)) continue;
			fields.push(`\`${key}\` = ?`);
			values.push(value);
		}
		if (!fields.length) return;
		fields.push('updated_at = NOW()');
		values.push(id);
		await this.db.query(`UPDATE hub_requests SET ${fields.join(', ')} WHERE id = ?`, values);
	}

	async _getRequest(id) {
		if (!id) return null;
		const [rows] = await this.db.query('SELECT * FROM hub_requests WHERE id = ?', [id]);
		return rows?.[0] || null;
	}

	async _fetchChannelFromRequest(request) {
		if (!request?.user_id || !request?.guild_id) return null;
		const record = await this._getHubRecord(request.guild_id, request.user_id);
		if (!record?.channel_id) return null;
		return this._fetchChannel(record.channel_id);
	}

	// ===== Hub channel infra =====

	async _findExistingHubChannel(guild, userId) {
		try {
			const channels = await guild.channels.fetch();
			for (const channel of channels.values()) {
				if (channel?.type !== ChannelType.GuildText) continue;
				const topic = (channel.topic || '').toLowerCase();
				if (topic.includes(`hub:user:${userId}`) || topic.includes(`onboarding:user:${userId}`)) {
					return channel;
				}
			}
		} catch (err) {
			this.logger?.warn({ err, guildId: guild.id }, 'Failed to scan hub channels');
		}
		return null;
	}

	async _buildHubChannelIndex(guild) {
		const index = new Map();
		try {
			const channels = await guild.channels.fetch();
			for (const channel of channels.values()) {
				if (channel?.type !== ChannelType.GuildText) continue;
				const topic = (channel.topic || '').toLowerCase();
				let match = topic.match(/hub:user:(\d{17,20})/);
				if (!match) {
					match = topic.match(/onboarding:user:(\d{17,20})/);
				}
				if (match) {
					index.set(match[1], channel);
				}
			}
		} catch (err) {
			this.logger?.warn({ err, guildId: guild.id }, 'Failed to index hub channels');
		}
		return index;
	}

	async _ensureHubCategory(guild) {
		const existing = guild.channels.cache.find(
			(channel) =>
				channel.type === ChannelType.GuildCategory &&
				HUB_CATEGORY_NAMES.includes(channel.name.toLowerCase())
		);
		if (existing) return existing;
		try {
			return await guild.channels.create({
				name: 'Hub',
				type: ChannelType.GuildCategory,
				reason: 'Hub channels'
			});
		} catch (err) {
			this.logger?.warn({ err, guildId: guild.id }, 'Failed to create hub category');
			return null;
		}
	}

	// ===== Panel message helpers =====

	async _upsertPanelMessage(channel, messageId, payload) {
		let message = null;
		if (messageId) {
			message = await channel.messages.fetch(messageId).catch(() => null);
			if (message) {
				await message.edit(payload).catch((err) => {
					if (err?.code === 10008) return; // Unknown message
					this.logger?.warn({ err, messageId, channelId: channel?.id }, 'Failed to edit hub panel message');
				});
			}
		}

		if (!message) {
			message = await channel.send(payload).catch(() => null);
		}

		return message?.id || null;
	}

	_buildJoinPanelPayload(guildId) {
		const welcomeService = this.services?.welcome || this.client?.context?.services?.welcome;
		if (welcomeService?.buildWizardPayload) {
			return welcomeService.buildWizardPayload(guildId);
		}
		return {
			embeds: [
				new EmbedBuilder()
					.setTitle('Bienvenue')
					.setDescription('Le panneau de zones est indisponible pour le moment.')
					.setColor(DEFAULT_COLOR)
			],
			components: []
		};
	}

	_buildRequestPanelPayload() {
		const embed = new EmbedBuilder()
			.setTitle('📢 Annonces & Événements')
			.setDescription(
				[
					'**Tu souhaites partager un message ou organiser un événement de jeu ?**',
					'Utilise les boutons ci-dessous pour créer ta demande !',
					'',
					'**📣 ANNONCE**',
					'Partage un message à toutes les zones',
					'• `Titre`**`*`** - Le titre de ton annonce',
					'• `Contenu`**`*`** - Ton message complet',
					'• `Couleur` - Code couleur (#RRGGBB) pour personnaliser',
					'• `Tags` - Catégories séparées par des virgules',
					'• `Image` - Illustration pour ton annonce',
					'',
					'**🎮 ÉVÉNEMENT**',
					'Organise une soirée de jeu avec zone temporaire dédiée',
					'• `Titre`**`*`** - Nom de ton événement',
					'• `Contenu`**`*`** - Description de l\'événement',
					'• `Couleur` - Code couleur (#RRGGBB) pour personnaliser',
					'• `Participants` - Nombre min/max de joueurs',
					'• `Tags` - Type d\'événement (PvP, Coop, etc.)',
					'• `Jeu` - Nom du jeu concerné',
					'• `Image` - Illustration pour ton événement',
					'',
					'**⚙️ Options supplémentaires**',
					'• **Image** : Si tu choisis "oui", envoie ton image juste après validation',
					'• **Programmation** : Configure la date/heure dans l\'aperçu',
					'• **Modération** : Ta demande sera validée par l\'équipe avant publication',
					'',
					'> 💡 *Les événements créent automatiquement une zone temporaire dédiée*',
					'> **`*`** *Champs obligatoires*'
				].join('\n')
			)
			.setColor(DEFAULT_COLOR)
			.setFooter({ text: '✨ Prêt à animer la communauté ?' });

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId('hub:announce:new')
				.setLabel('📣 Créer une annonce')
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId('hub:event:new')
				.setLabel('🎮 Créer un événement')
				.setStyle(ButtonStyle.Success)
		);

		return { embeds: [embed], components: [row] };
	}

	_setPendingImage({ guildId, userId, channelId, recordId }) {
		if (!guildId || !userId || !recordId) return;
		this.pendingImages.set(`${guildId}:${userId}`, {
			channelId,
			recordId,
			requestedAt: Date.now()
		});
	}
}

Object.assign(HubService.prototype, requests, builders);

module.exports = { HubService };
