const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	PermissionFlagsBits,
	TextInputBuilder,
	TextInputStyle
} = require('discord.js');
const { shortId } = require('../utils/ids');

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

	setServices(services) {
		this.services = services || null;
	}

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
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch(() => {});

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
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch(() => {});

		this.#schemaReady = true;
	}

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

		const channelIndex = await this.#buildHubChannelIndex(guild);

		for (const member of members.values()) {
			if (member.user?.bot) continue;
			await this.ensureHubChannelForMember(member, channelIndex).catch((err) => {
				this.logger?.warn({ err, guildId: guild.id, userId: member.id }, 'Failed to ensure hub channel');
			});
			await this.#sleep(350);
		}
	}

	async ensureHubChannelForMember(member, channelIndex = null) {
		if (!member || member.user?.bot) return null;
		await this.ensureSchema();

		const guild = member.guild;
		const guildId = guild.id;

		let record = await this.#getHubRecord(guildId, member.id);
		let channel = record?.channel_id ? await this.#fetchChannel(record.channel_id) : null;

		if (!channel) {
			channel = channelIndex?.get?.(member.id) || null;
		}
		if (!channel) {
			channel = await this.#findExistingHubChannel(guild, member.id);
		}

		if (!channel) {
			const category = await this.#ensureHubCategory(guild);
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
			channel.setTopic(desiredTopic).catch(() => {});
		}

		const joinMessageId = await this.#upsertPanelMessage(
			channel,
			record?.join_message_id || null,
			this.#buildJoinPanelPayload(guildId)
		);
		const requestMessageId = await this.#upsertPanelMessage(
			channel,
			record?.request_message_id || null,
			this.#buildRequestPanelPayload()
		);

		record = await this.#setHubRecord(guildId, member.id, channel.id, joinMessageId, requestMessageId);
		return channel;
	}

	async handleButton(interaction) {
		const id = interaction?.customId || '';
		if (!id.startsWith('hub:')) return false;

		await this.ensureSchema();

		if (id === 'hub:announce:new') {
			const modal = this.#buildAnnouncementModal(null, { title: 'Demander une annonce' });
			await interaction.showModal(modal);
			return true;
		}

		if (id === 'hub:event:new') {
			const modal = this.#buildEventModal(null, { title: 'Demander un evenement' });
			await interaction.showModal(modal);
			return true;
		}

		let match = id.match(/^hub:req:edit:(\d+)/);
		if (match) {
			const requestId = Number(match[1]);
			const request = await this.#getRequest(requestId);
			if (!request) {
				await this.#reply(interaction, { content: 'Demande introuvable.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.user_id !== interaction.user.id) {
				await this.#reply(interaction, { content: 'Action non autorisee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.status !== 'draft') {
				await this.#reply(interaction, { content: 'Demande deja envoyee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.kind === 'announcement') {
				const modal = this.#buildAnnouncementModal(request, { title: 'Modifier une annonce' });
				await interaction.showModal(modal);
				return true;
			}
			const modal = this.#buildEventModal(request, { title: 'Modifier un evenement' });
			await interaction.showModal(modal);
			return true;
		}

		match = id.match(/^hub:req:schedule:(\d+)/);
		if (match) {
			const requestId = Number(match[1]);
			const request = await this.#getRequest(requestId);
			if (!request) {
				await this.#reply(interaction, { content: 'Demande introuvable.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.user_id !== interaction.user.id) {
				await this.#reply(interaction, { content: 'Action non autorisee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.status !== 'draft') {
				await this.#reply(interaction, { content: 'Demande deja envoyee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			const modal = this.#buildScheduleModal(request);
			await interaction.showModal(modal);
			return true;
		}

		match = id.match(/^hub:req:submit:(\d+)/);
		if (match) {
			await this.#deferReply(interaction);
			const requestId = Number(match[1]);
			const request = await this.#getRequest(requestId);
			if (!request) {
				await this.#reply(interaction, { content: 'Demande introuvable.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.user_id !== interaction.user.id) {
				await this.#reply(interaction, { content: 'Action non autorisee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.status !== 'draft') {
				await this.#reply(interaction, { content: 'Demande deja envoyee.', flags: MessageFlags.Ephemeral });
				return true;
			}

			await this.#updateRequest(request.id, { status: 'pending' });
			const updated = await this.#getRequest(request.id);
			await this.#deliverRequest(updated);
			await this.#disablePreviewMessage(updated, 'Demande envoyee');
			await this.#reply(interaction, { content: 'Demande envoyee.', flags: MessageFlags.Ephemeral });
			return true;
		}

		match = id.match(/^hub:req:(deny|accept|editaccept):(\d+)/);
		if (match) {
			const action = match[1];
			const requestId = Number(match[2]);
			if (!this.#isOwner(interaction)) {
				await this.#reply(interaction, { content: 'Action reservee a l\'owner.', flags: MessageFlags.Ephemeral });
				return true;
			}
			const request = await this.#getRequest(requestId);
			if (!request) {
				await this.#reply(interaction, { content: 'Demande introuvable.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.status !== 'pending') {
				await this.#reply(interaction, { content: 'Demande deja traitee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (action === 'deny') {
				await this.#deferReply(interaction);
				await this.#denyRequest(request, interaction.user.id);
				await this.#reply(interaction, { content: 'Demande refusee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (action === 'accept') {
				await this.#deferReply(interaction);
				const result = await this.#acceptRequest(request, interaction.user.id);
				if (!result.ok) {
					await this.#reply(interaction, { content: result.message || 'Impossible d\'accepter.', flags: MessageFlags.Ephemeral });
					return true;
				}
				await this.#reply(interaction, { content: 'Demande acceptee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (action === 'editaccept') {
				const modal = this.#buildEditAcceptModal(request);
				await interaction.showModal(modal);
				return true;
			}
		}

		await this.#reply(interaction, { content: 'Action inconnue.', flags: MessageFlags.Ephemeral });
		return true;
	}

	async handleModal(interaction) {
		const id = interaction?.customId || '';
		if (!id.startsWith('hub:')) return false;

		await this.ensureSchema();

		if (id.startsWith('hub:announce:modal')) {
			await this.#handleAnnouncementModal(interaction);
			return true;
		}

		if (id.startsWith('hub:event:modal')) {
			await this.#handleEventModal(interaction);
			return true;
		}

		let match = id.match(/^hub:req:schedule:modal:(\d+)/);
		if (match) {
			const requestId = Number(match[1]);
			const request = await this.#getRequest(requestId);
			if (!request) {
				await this.#reply(interaction, { content: 'Demande introuvable.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.user_id !== interaction.user.id) {
				await this.#reply(interaction, { content: 'Action non autorisee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.status !== 'draft') {
				await this.#reply(interaction, { content: 'Demande deja envoyee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			await this.#handleScheduleModal(interaction, request);
			return true;
		}

		match = id.match(/^hub:req:editaccept:modal:(\d+)/);
		if (match) {
			const requestId = Number(match[1]);
			const request = await this.#getRequest(requestId);
			if (!request) {
				await this.#reply(interaction, { content: 'Demande introuvable.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (!this.#isOwner(interaction)) {
				await this.#reply(interaction, { content: 'Action reservee a l\'owner.', flags: MessageFlags.Ephemeral });
				return true;
			}
			if (request.status !== 'pending') {
				await this.#reply(interaction, { content: 'Demande deja traitee.', flags: MessageFlags.Ephemeral });
				return true;
			}
			await this.#handleEditAcceptModal(interaction, request);
			return true;
		}

		return false;
	}

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

		const attachment = this.#extractImageAttachment(message);
		if (!attachment) {
			await message.reply('Merci d\'envoyer une image (png, jpg, gif, webp).').catch(() => {});
			return true;
		}

		this.pendingImages.delete(key);
		await this.ensureSchema();

		try {
			await this.#updateRequest(pending.recordId, { embed_image: attachment.url });
			const request = await this.#getRequest(pending.recordId);
			if (request) {
				await this.#upsertPreviewMessage(request);
				await message.reply('Image ajoutee, apercu mis a jour.').catch(() => {});
			}
			return true;
		} catch (err) {
			this.logger?.warn({ err, recordId: pending.recordId }, 'Failed to attach image to hub request');
			await message.reply('Impossible de recuperer cette image pour le moment.').catch(() => {});
			return true;
		}
	}

	async #handleAnnouncementModal(interaction) {
		try {
			const customId = interaction.customId;
			const existingId = Number(customId.split(':').at(-1));

			const existing = existingId ? await this.#getRequest(existingId) : null;
			if (existing && existing.user_id !== interaction.user.id) {
				await this.#reply(interaction, { content: 'Action non autorisee.', flags: MessageFlags.Ephemeral });
				return;
			}

			const embedTitle = interaction.fields.getTextInputValue('announceTitle')?.trim() || null;
			const embedDescription = interaction.fields.getTextInputValue('announceContent')?.trim() || null;
			const colorRaw = interaction.fields.getTextInputValue('announceColor')?.trim() || '';
			const tagRaw = interaction.fields.getTextInputValue('announceTag')?.trim() || '';
			const tagValue = tagRaw ? tagRaw.slice(0, 128) : '';
			const imageRaw = interaction.fields.getTextInputValue('announceImage')?.trim() || '';

			const embedColor = colorRaw ? this.#normalizeColor(colorRaw) : null;
			if (colorRaw && !embedColor) {
				await this.#reply(interaction, {
					content: 'Couleur invalide. Utilise le format #RRGGBB.',
					flags: MessageFlags.Ephemeral
				});
				return;
			}

			const imageUrl = this.#normalizeUrl(imageRaw);
			const wantsImage = this.#isAffirmative(imageRaw);
			let embedImage = existing?.embed_image || null;
			let pendingImage = false;
			if (imageUrl) {
				embedImage = imageUrl;
			} else if (wantsImage) {
				embedImage = null;
				pendingImage = true;
			}

			const payload = {
				guild_id: interaction.guildId,
				user_id: interaction.user.id,
				kind: 'announcement',
				content: tagValue || null,
				embed_title: embedTitle,
				embed_description: embedDescription,
				embed_color: embedColor,
				embed_image: embedImage,
				scheduled_at: existing?.scheduled_at || null,
				status: 'draft'
			};

			let request = null;
			if (existing?.id) {
				await this.#updateRequest(existing.id, payload);
				request = await this.#getRequest(existing.id);
			} else {
				const id = await this.#insertRequest(payload);
				request = await this.#getRequest(id);
			}

			if (pendingImage) {
				this.#setPendingImage({
					guildId: interaction.guildId,
					userId: interaction.user.id,
					channelId: interaction.channelId,
					recordId: request.id
				});
				await this.#reply(interaction, {
					content: 'Envoie l\'image dans ce salon pour generer l\'apercu.',
					flags: MessageFlags.Ephemeral
				});
				return;
			}

			await this.#upsertPreviewMessage(request);
			await this.#reply(interaction, {
				content: 'Apercu mis a jour dans ce salon.',
				flags: MessageFlags.Ephemeral
			});
		} catch (err) {
			this.logger?.warn({ err }, 'Failed to handle hub announcement modal');
			await this.#reply(interaction, {
				content: 'Impossible de preparer l\'annonce.',
				flags: MessageFlags.Ephemeral
			});
		}
	}

	async #handleEventModal(interaction) {
		try {
			const customId = interaction.customId;
			const existingId = Number(customId.split(':').at(-1));

			const existing = existingId ? await this.#getRequest(existingId) : null;
			if (existing && existing.user_id !== interaction.user.id) {
				await this.#reply(interaction, { content: 'Action non autorisee.', flags: MessageFlags.Ephemeral });
				return;
			}

			const name = interaction.fields.getTextInputValue('eventName')?.trim() || '';
			const description = interaction.fields.getTextInputValue('eventContent')?.trim() || null;
			const colorRaw = interaction.fields.getTextInputValue('eventColor')?.trim() || '';
			const participantsRaw = interaction.fields.getTextInputValue('eventParticipants')?.trim() || '';
			const optionsRaw = interaction.fields.getTextInputValue('eventOptions') || '';

			if (!name) {
				await this.#reply(interaction, { content: 'Le titre est obligatoire.', flags: MessageFlags.Ephemeral });
				return;
			}

			const options = this.#parseOptions(optionsRaw);
			const tagRaw = options.tag || options.type || '';
			const tagValue = tagRaw ? String(tagRaw).trim().slice(0, 128) : null;
			const gameRaw = options.jeu || options['jeu.x'] || options.game || options.jeux || '';
			const game = gameRaw ? String(gameRaw).trim().slice(0, 120) : null;
			const imageRaw = options.image || options.img || '';

			const embedColor = colorRaw ? this.#normalizeColor(colorRaw) : null;
			if (colorRaw && !embedColor) {
				await this.#reply(interaction, {
					content: 'Couleur invalide. Utilise le format #RRGGBB.',
					flags: MessageFlags.Ephemeral
				});
				return;
			}

			const imageUrl = this.#normalizeUrl(imageRaw);
			const wantsImage = this.#isAffirmative(imageRaw);
			let embedImage = existing?.embed_image || null;
			let pendingImage = false;
			if (imageUrl) {
				embedImage = imageUrl;
			} else if (wantsImage) {
				embedImage = null;
				pendingImage = true;
			}

			const participantLimits = this.#parseParticipants(participantsRaw);

			const payload = {
				guild_id: interaction.guildId,
				user_id: interaction.user.id,
				kind: 'event',
				embed_title: name,
				embed_description: description,
				embed_color: embedColor,
				embed_image: embedImage,
				message_content: tagValue,
				game,
				min_participants: participantLimits.min,
				max_participants: participantLimits.max,
				scheduled_at: existing?.scheduled_at || null,
				status: 'draft'
			};

			let request = null;
			if (existing?.id) {
				await this.#updateRequest(existing.id, payload);
				request = await this.#getRequest(existing.id);
			} else {
				const id = await this.#insertRequest(payload);
				request = await this.#getRequest(id);
			}

			if (pendingImage) {
				this.#setPendingImage({
					guildId: interaction.guildId,
					userId: interaction.user.id,
					channelId: interaction.channelId,
					recordId: request.id
				});
				await this.#reply(interaction, {
					content: 'Envoie l\'image dans ce salon pour generer l\'apercu.',
					flags: MessageFlags.Ephemeral
				});
				return;
			}

			await this.#upsertPreviewMessage(request);
			await this.#reply(interaction, {
				content: 'Apercu mis a jour dans ce salon.',
				flags: MessageFlags.Ephemeral
			});
		} catch (err) {
			this.logger?.warn({ err }, 'Failed to handle hub event modal');
			await this.#reply(interaction, {
				content: 'Impossible de preparer l\'evenement.',
				flags: MessageFlags.Ephemeral
			});
		}
	}

	async #handleScheduleModal(interaction, request) {
		const dateRaw = interaction.fields.getTextInputValue('scheduleDate')?.trim() || '';
		const timeRaw = interaction.fields.getTextInputValue('scheduleTime')?.trim() || '';
		const scheduledAt = this.#parseParisSchedule(dateRaw, timeRaw);
		if (!scheduledAt) {
			await this.#reply(interaction, {
				content: 'Date ou heure invalide. Format attendu : JJ-MM-YYYY et HH:MM.',
				flags: MessageFlags.Ephemeral
			});
			return;
		}

		await this.#updateRequest(request.id, { scheduled_at: scheduledAt });
		const updated = await this.#getRequest(request.id);
		await this.#upsertPreviewMessage(updated);
		await this.#reply(interaction, {
			content: `Programme pour ${this.#formatSchedule(scheduledAt)}.`,
			flags: MessageFlags.Ephemeral
		});
	}

	async #handleEditAcceptModal(interaction, request) {
		try {
			if (request.kind === 'announcement') {
				const embedTitle = interaction.fields.getTextInputValue('announceTitle')?.trim() || null;
				const embedDescription = interaction.fields.getTextInputValue('announceContent')?.trim() || null;
				const colorRaw = interaction.fields.getTextInputValue('announceColor')?.trim() || '';
				const tagRaw = interaction.fields.getTextInputValue('announceTag')?.trim() || '';
				const tagValue = tagRaw ? tagRaw.slice(0, 128) : '';
				const imageRaw = interaction.fields.getTextInputValue('announceImage')?.trim() || '';

				const embedColor = colorRaw ? this.#normalizeColor(colorRaw) : null;
				if (colorRaw && !embedColor) {
					await this.#reply(interaction, { content: 'Couleur invalide.', flags: MessageFlags.Ephemeral });
					return;
				}

				let embedImage = request.embed_image || null;
				if (imageRaw) {
					const imageUrl = this.#normalizeUrl(imageRaw);
					if (!imageUrl) {
						await this.#reply(interaction, { content: 'Image invalide (URL attendue).', flags: MessageFlags.Ephemeral });
						return;
					}
					embedImage = imageUrl;
				}

				await this.#updateRequest(request.id, {
					content: tagValue || null,
					embed_title: embedTitle,
					embed_description: embedDescription,
					embed_color: embedColor,
					embed_image: embedImage
				});
			} else {
				const name = interaction.fields.getTextInputValue('eventName')?.trim() || '';
				const description = interaction.fields.getTextInputValue('eventContent')?.trim() || null;
				const colorRaw = interaction.fields.getTextInputValue('eventColor')?.trim() || '';
				const participantsRaw = interaction.fields.getTextInputValue('eventParticipants')?.trim() || '';
				const optionsRaw = interaction.fields.getTextInputValue('eventOptions') || '';

				if (!name) {
					await this.#reply(interaction, { content: 'Le titre est obligatoire.', flags: MessageFlags.Ephemeral });
					return;
				}

				const options = this.#parseOptions(optionsRaw);
				const tagRaw = options.tag || options.type || '';
				const tagValue = tagRaw ? String(tagRaw).trim().slice(0, 128) : null;
				const gameRaw = options.jeu || options['jeu.x'] || options.game || options.jeux || '';
				const game = gameRaw ? String(gameRaw).trim().slice(0, 120) : null;
				const imageRaw = options.image || options.img || '';

				const embedColor = colorRaw ? this.#normalizeColor(colorRaw) : null;
				if (colorRaw && !embedColor) {
					await this.#reply(interaction, { content: 'Couleur invalide.', flags: MessageFlags.Ephemeral });
					return;
				}

				let embedImage = request.embed_image || null;
				if (imageRaw) {
					const imageUrl = this.#normalizeUrl(imageRaw);
					if (!imageUrl) {
						await this.#reply(interaction, { content: 'Image invalide (URL attendue).', flags: MessageFlags.Ephemeral });
						return;
					}
					embedImage = imageUrl;
				}

				const participantLimits = this.#parseParticipants(participantsRaw);

				await this.#updateRequest(request.id, {
					embed_title: name,
					embed_description: description,
					embed_color: embedColor,
					embed_image: embedImage,
					message_content: tagValue,
					game,
					min_participants: participantLimits.min,
					max_participants: participantLimits.max
				});
			}

			const updated = await this.#getRequest(request.id);
			const result = await this.#acceptRequest(updated, interaction.user.id);
			if (!result.ok) {
				await this.#reply(interaction, { content: result.message || 'Impossible d\'accepter.', flags: MessageFlags.Ephemeral });
				return;
			}

			await this.#reply(interaction, { content: 'Demande acceptee.', flags: MessageFlags.Ephemeral });
		} catch (err) {
			this.logger?.warn({ err, requestId: request.id }, 'Failed to edit/accept hub request');
			await this.#reply(interaction, { content: 'Impossible de traiter la demande.', flags: MessageFlags.Ephemeral });
		}
	}

	async #acceptRequest(request, actorId) {
		const staffPanel = this.services?.staffPanel || this.client?.context?.services?.staffPanel;
		if (!staffPanel) {
			return { ok: false, message: 'Staff panel indisponible.' };
		}

		try {
			if (request.kind === 'announcement') {
				await staffPanel.submitAnnouncementFromRequest(request, actorId);
			} else {
				await staffPanel.submitEventFromRequest(request, actorId);
			}

			await this.#updateRequest(request.id, {
				status: 'accepted',
				decided_by: actorId,
				decided_at: new Date()
			});
			const updated = await this.#getRequest(request.id);
			await this.#disableReviewMessage(updated, 'Acceptee');
			await this.#disablePreviewMessage(updated, 'Acceptee');
			await this.#notifyUser(request.user_id, {
				content: request.kind === 'announcement'
					? '✅ Ton annonce a ete acceptee.'
					: '✅ Ton evenement a ete accepte.'
			});
			return { ok: true };
		} catch (err) {
			this.logger?.warn({ err, requestId: request.id }, 'Failed to accept hub request');
			return { ok: false, message: 'Impossible d\'envoyer la demande.' };
		}
	}

	async #denyRequest(request, actorId) {
		await this.#updateRequest(request.id, {
			status: 'denied',
			decided_by: actorId,
			decided_at: new Date()
		});
		const updated = await this.#getRequest(request.id);
		await this.#disableReviewMessage(updated, 'Refusee');
		await this.#disablePreviewMessage(updated, 'Refusee');
		await this.#notifyUser(request.user_id, {
			content: request.kind === 'announcement'
				? '❌ Ton annonce a ete refusee.'
				: '❌ Ton evenement a ete refuse.'
		});
	}

	async #deliverRequest(request) {
		if (!request) return false;
		const payload = this.#buildReviewPayload(request);
		const ownerId = this.#getOwnerId();
		const channelId = await this.#getRequestsChannelId(request.guild_id);

		let message = null;
		if (channelId) {
			try {
				const channel = await this.client.channels.fetch(channelId);
				if (channel?.isTextBased?.()) {
					const content = ownerId ? `<@${ownerId}>` : null;
					message = await channel.send({
						content: content || undefined,
						...payload,
						allowedMentions: ownerId ? { users: [ownerId] } : { parse: [] }
					}).catch(() => null);
				}
			} catch (err) {
				this.logger?.warn({ err, channelId }, 'Failed to forward hub request to channel');
			}
		}

		if (!message && ownerId) {
			try {
				const ownerUser = await this.client.users.fetch(ownerId);
				message = await ownerUser.send({
					...payload,
					allowedMentions: { parse: [] }
				}).catch(() => null);
			} catch (err) {
				this.logger?.warn({ err, ownerId }, 'Failed to DM owner for hub request');
			}
		}

		if (message) {
			await this.#updateRequest(request.id, {
				review_channel_id: message.channelId,
				review_message_id: message.id
			});
			return true;
		}

		return false;
	}

	#buildJoinPanelPayload(guildId) {
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

	#buildRequestPanelPayload() {
		const embed = new EmbedBuilder()
			.setTitle('Demandes d\'annonces et d\'evenements')
			.setDescription(
				[
					'Utilise ces boutons pour preparer une annonce ou un evenement.',
					'Tu pourras programmer une date avant l\'envoi.'
				].join('\n')
			)
			.setColor(DEFAULT_COLOR);

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId('hub:announce:new')
				.setLabel('Demander une annonce')
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId('hub:event:new')
				.setLabel('Demander un evenement')
				.setStyle(ButtonStyle.Secondary)
		);

		return { embeds: [embed], components: [row] };
	}

	async #upsertPanelMessage(channel, messageId, payload) {
		let message = null;
		if (messageId) {
			message = await channel.messages.fetch(messageId).catch(() => null);
			if (message) {
				await message.edit(payload).catch(() => {});
			}
		}

		if (!message) {
			message = await channel.send(payload).catch(() => null);
		}

		return message?.id || null;
	}

	async #upsertPreviewMessage(request) {
		if (!request) return;
		const channelId = request.preview_channel_id;
		const messageId = request.preview_message_id;
		const channel = channelId
			? await this.client.channels.fetch(channelId).catch(() => null)
			: await this.#fetchChannelFromRequest(request);

		if (!channel?.isTextBased?.()) return;
		const payload = this.#buildRequestPreview(request);
		let message = null;
		if (messageId) {
			message = await channel.messages.fetch(messageId).catch(() => null);
			if (message) {
				await message.edit(payload).catch(() => {});
			}
		}
		if (!message) {
			message = await channel.send(payload).catch(() => null);
		}
		if (message) {
			await this.#updateRequest(request.id, {
				preview_channel_id: message.channelId,
				preview_message_id: message.id
			});
		}
	}

	#buildRequestPreview(request) {
		const payload = request.kind === 'announcement'
			? this.#buildAnnouncementPayload(request)
			: this.#buildEventPayload(request);
		const prefix = request.scheduled_at
			? `Previsualisation. Date prevue : ${this.#formatSchedule(request.scheduled_at)}`
			: 'Previsualisation.';
		const content = this.#mergePreviewContent(prefix, payload.content);
		const components = request.status === 'draft' ? this.#buildRequestActions(request) : [];

		return {
			content,
			embeds: payload.embeds,
			components,
			allowedMentions: { parse: [] }
		};
	}

	#buildRequestActions(request) {
		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`hub:req:edit:${request.id}`)
				.setLabel('Modifier')
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`hub:req:submit:${request.id}`)
				.setLabel('Envoyer la demande')
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId(`hub:req:schedule:${request.id}`)
				.setLabel('Programmer')
				.setStyle(ButtonStyle.Secondary)
		);
		return [row];
	}

	#buildReviewPayload(request) {
		const meta = new EmbedBuilder()
			.setTitle(request.kind === 'announcement' ? 'Demande d\'annonce' : 'Demande d\'evenement')
			.setColor(DEFAULT_COLOR)
			.addFields(
				{ name: 'Demandeur', value: `<@${request.user_id}> (${request.user_id})`, inline: false },
				{
					name: 'Programme',
					value: request.scheduled_at ? this.#formatSchedule(request.scheduled_at) : 'Envoi immediat',
					inline: false
				}
			)
			.setTimestamp(new Date(request.created_at || Date.now()));

		if (request.kind === 'announcement') {
			meta.addFields({
				name: 'Tag',
				value: request.content ? String(request.content).slice(0, 1024) : 'Aucun',
				inline: false
			});
		}

		const preview = request.kind === 'announcement'
			? this.#buildAnnouncementPayload(request)
			: this.#buildEventPayload(request);

		const components = [
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`hub:req:deny:${request.id}`)
					.setLabel('Refuser')
					.setStyle(ButtonStyle.Danger),
				new ButtonBuilder()
					.setCustomId(`hub:req:editaccept:${request.id}`)
					.setLabel('Modifier & Accepter')
					.setStyle(ButtonStyle.Secondary),
				new ButtonBuilder()
					.setCustomId(`hub:req:accept:${request.id}`)
					.setLabel('Accepter')
					.setStyle(ButtonStyle.Success)
			)
		];

		return {
			embeds: [meta, ...preview.embeds],
			components,
			allowedMentions: { parse: [] }
		};
	}

	async #disableReviewMessage(request, statusLabel) {
		if (!request?.review_channel_id || !request?.review_message_id) return;
		try {
			const channel = await this.client.channels.fetch(request.review_channel_id).catch(() => null);
			if (!channel?.messages?.fetch) return;
			const message = await channel.messages.fetch(request.review_message_id).catch(() => null);
			if (!message) return;

			const components = this.#disableMessageComponents(message);
			const payload = this.#buildReviewPayload(request);
			if (statusLabel) {
				payload.embeds[0].setFooter({ text: statusLabel });
			}

			await message.edit({ embeds: payload.embeds, components }).catch(() => {});
		} catch (err) {
			this.logger?.warn({ err, requestId: request?.id }, 'Failed to update hub review message');
		}
	}

	async #disablePreviewMessage(request, statusLabel) {
		if (!request?.preview_channel_id || !request?.preview_message_id) return;
		try {
			const channel = await this.client.channels.fetch(request.preview_channel_id).catch(() => null);
			if (!channel?.messages?.fetch) return;
			const message = await channel.messages.fetch(request.preview_message_id).catch(() => null);
			if (!message) return;

			const payload = this.#buildRequestPreview({ ...request, status: 'locked' });
			if (statusLabel) {
				payload.content = `${payload.content}\n\nStatut: ${statusLabel}`;
			}
			await message.edit({ content: payload.content, embeds: payload.embeds, components: [] }).catch(() => {});
		} catch (err) {
			this.logger?.warn({ err, requestId: request?.id }, 'Failed to update hub preview message');
		}
	}

	#disableMessageComponents(message) {
		const components = [];
		for (const row of message.components || []) {
			const newRow = new ActionRowBuilder();
			for (const component of row.components || []) {
				try {
					const cloned = ButtonBuilder.from(component);
					cloned.setDisabled(true);
					newRow.addComponents(cloned);
				} catch {}
			}
			if (newRow.components.length) components.push(newRow);
		}
		return components;
	}

	#buildAnnouncementModal(existing = null, options = {}) {
		const modalId = options.customId || `hub:announce:modal${existing?.id ? `:${existing.id}` : ''}`;
		const modalTitle = options.title || 'Demander une annonce';
		const modal = new ModalBuilder().setCustomId(modalId).setTitle(modalTitle);

		const titleInput = new TextInputBuilder()
			.setCustomId('announceTitle')
			.setLabel('Titre')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(256)
			.setValue(existing?.embed_title || '');

		const contentInput = new TextInputBuilder()
			.setCustomId('announceContent')
			.setLabel('Contenu')
			.setStyle(TextInputStyle.Paragraph)
			.setRequired(false)
			.setMaxLength(4000)
			.setValue(existing?.embed_description || '');

		const colorInput = new TextInputBuilder()
			.setCustomId('announceColor')
			.setLabel('Couleur (#RRGGBB)')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(16)
			.setPlaceholder('#5865F2')
			.setValue(existing?.embed_color || '');

		const tagInput = new TextInputBuilder()
			.setCustomId('announceTag')
			.setLabel('Tag (optionnel)')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(128)
			.setPlaceholder('@role ou @everyone')
			.setValue(existing?.content || '');

		const imageInput = new TextInputBuilder()
			.setCustomId('announceImage')
			.setLabel('Image (oui ou vide)')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(120)
			.setPlaceholder('oui');

		modal.addComponents(
			new ActionRowBuilder().addComponents(titleInput),
			new ActionRowBuilder().addComponents(contentInput),
			new ActionRowBuilder().addComponents(colorInput),
			new ActionRowBuilder().addComponents(tagInput),
			new ActionRowBuilder().addComponents(imageInput)
		);

		return modal;
	}

	#buildEventModal(existing = null, options = {}) {
		const modalId = options.customId || `hub:event:modal${existing?.id ? `:${existing.id}` : ''}`;
		const modalTitle = options.title || 'Demander un evenement';
		const modal = new ModalBuilder().setCustomId(modalId).setTitle(modalTitle);

		const contentInput = new TextInputBuilder()
			.setCustomId('eventContent')
			.setLabel('Contenu')
			.setStyle(TextInputStyle.Paragraph)
			.setRequired(false)
			.setMaxLength(4000)
			.setValue(existing?.embed_description || '');

		const nameInput = new TextInputBuilder()
			.setCustomId('eventName')
			.setLabel('Titre')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(120)
			.setValue(existing?.embed_title || '');

		const colorInput = new TextInputBuilder()
			.setCustomId('eventColor')
			.setLabel('Couleur (#RRGGBB)')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(16)
			.setPlaceholder('#5865F2')
			.setValue(existing?.embed_color || '');

		const participantsInput = new TextInputBuilder()
			.setCustomId('eventParticipants')
			.setLabel('Participants (min=/max=)')
			.setStyle(TextInputStyle.Short)
			.setRequired(false)
			.setMaxLength(64)
			.setPlaceholder('min=5 max=20')
			.setValue(this.#formatParticipants(existing));

		const optionsInput = new TextInputBuilder()
			.setCustomId('eventOptions')
			.setLabel('Tag (type) / Jeu.x / Image')
			.setStyle(TextInputStyle.Paragraph)
			.setRequired(false)
			.setMaxLength(600)
			.setPlaceholder('tag=Roleplay\njeu=Nom du jeu\nimage=oui')
			.setValue(this.#formatEventOptions(existing));

		modal.addComponents(
			new ActionRowBuilder().addComponents(nameInput),
			new ActionRowBuilder().addComponents(contentInput),
			new ActionRowBuilder().addComponents(colorInput),
			new ActionRowBuilder().addComponents(participantsInput),
			new ActionRowBuilder().addComponents(optionsInput)
		);

		return modal;
	}

	#buildScheduleModal(request) {
		const modal = new ModalBuilder()
			.setCustomId(`hub:req:schedule:modal:${request.id}`)
			.setTitle(request.kind === 'announcement' ? 'Programmer une annonce' : 'Programmer un evenement');

		const dateInput = new TextInputBuilder()
			.setCustomId('scheduleDate')
			.setLabel('Date (JJ-MM-YYYY)')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(10)
			.setPlaceholder('20-01-2026');

		const timeInput = new TextInputBuilder()
			.setCustomId('scheduleTime')
			.setLabel('Heure (HH:MM)')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(5)
			.setPlaceholder('14:30');

		if (request?.scheduled_at) {
			const parts = this.#formatParisScheduleParts(request.scheduled_at);
			if (parts?.date) dateInput.setValue(parts.date);
			if (parts?.time) timeInput.setValue(parts.time);
		}

		modal.addComponents(
			new ActionRowBuilder().addComponents(dateInput),
			new ActionRowBuilder().addComponents(timeInput)
		);

		return modal;
	}

	#buildEditAcceptModal(request) {
		if (request.kind === 'announcement') {
			return this.#buildAnnouncementModal(request, {
				customId: `hub:req:editaccept:modal:${request.id}`,
				title: 'Modifier et accepter'
			});
		}
		return this.#buildEventModal(request, {
			customId: `hub:req:editaccept:modal:${request.id}`,
			title: 'Modifier et accepter'
		});
	}

	#buildAnnouncementPayload(request) {
		const embeds = [];
		const embed = new EmbedBuilder();
		let hasEmbed = false;

		const contentParts = [];
		if (request.content) contentParts.push(request.content);

		if (request.embed_title) {
			embed.setTitle(request.embed_title.slice(0, 256));
			hasEmbed = true;
		}
		if (request.embed_description) {
			embed.setDescription(request.embed_description.slice(0, 4096));
			hasEmbed = true;
		}

		const color = this.#resolveColor(request.embed_color) || DEFAULT_COLOR;
		embed.setColor(color);
		hasEmbed = true;

		if (request.embed_image) {
			embed.setImage(request.embed_image);
			hasEmbed = true;
		}

		if (hasEmbed) embeds.push(embed);
		const content = contentParts.length ? contentParts.join('\n') : null;
		return { content, embeds };
	}

	#buildEventPayload(request) {
		const embeds = [];
		const embed = new EmbedBuilder()
			.setTitle(request.embed_title?.slice(0, 256) || 'Evenement')
			.setDescription(request.embed_description?.slice(0, 4096) || 'Rejoins le groupe pour participer.');

		const minPart = request.min_participants ? Number(request.min_participants) : null;
		const maxPart = request.max_participants ? Number(request.max_participants) : null;
		if (minPart || maxPart) {
			const label = [
				minPart ? `min ${minPart}` : null,
				maxPart ? `max ${maxPart}` : null
			].filter(Boolean).join(' / ');
			embed.addFields({ name: 'Participants', value: label || '—', inline: false });
		}

		if (request.message_content) {
			embed.setFooter({ text: `Type: ${String(request.message_content).slice(0, 2000)}` });
		}

		if (request.game) {
			embed.addFields({ name: 'Jeu', value: String(request.game).slice(0, 256), inline: false });
		}

		if (request.embed_image) {
			embed.setImage(request.embed_image);
		}

		const color = this.#resolveColor(request.embed_color) || DEFAULT_COLOR;
		embed.setColor(color);
		embeds.push(embed);

		return { embeds, content: null };
	}

	#formatParticipants(existing) {
		if (!existing) return '';
		const min = existing.min_participants ? Number(existing.min_participants) : null;
		const max = existing.max_participants ? Number(existing.max_participants) : null;
		if (!min && !max) return '';
		if (min && max) return `min=${min} max=${max}`;
		if (min) return `min=${min}`;
		return `max=${max}`;
	}

	#formatEventOptions(existing) {
		if (!existing) return '';
		const lines = [];
		if (existing.message_content) {
			lines.push(`tag=${String(existing.message_content).replace(/\s+/g, ' ').slice(0, 128)}`);
		}
		if (existing.game) lines.push(`jeu=${String(existing.game).slice(0, 120)}`);
		if (existing.embed_image) lines.push(`image=${String(existing.embed_image).slice(0, 500)}`);
		return lines.join('\n');
	}

	#parseParticipants(raw) {
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

	#parseOptions(raw) {
		const result = {};
		if (!raw) return result;
		for (const line of String(raw).split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			const eq = trimmed.indexOf('=');
			if (eq === -1) continue;
			const key = trimmed.slice(0, eq).trim().toLowerCase();
			const value = trimmed.slice(eq + 1).trim();
			if (!key || !value) continue;
			result[key] = value;
		}
		return result;
	}

	#normalizeColor(value) {
		if (!value) return null;
		const trimmed = String(value).trim().replace(/^#/, '');
		if (!/^[0-9a-fA-F]{6}$/.test(trimmed)) return null;
		return `#${trimmed.toUpperCase()}`;
	}

	#resolveColor(value) {
		if (!value) return null;
		const normalized = this.#normalizeColor(value);
		if (!normalized) return null;
		return parseInt(normalized.slice(1), 16);
	}

	#normalizeUrl(value) {
		if (!value) return null;
		const trimmed = String(value).trim();
		if (!trimmed) return null;
		if (!/^https?:\/\//i.test(trimmed)) return null;
		return trimmed.slice(0, 500);
	}

	#isAffirmative(value) {
		const trimmed = String(value || '').trim().toLowerCase();
		return ['oui', 'yes', 'y', 'true', '1'].includes(trimmed);
	}

	#formatSchedule(value) {
		const dt = new Date(value);
		if (Number.isNaN(dt.getTime())) return 'date invalide';
		return dt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
	}

	#formatParisScheduleParts(value) {
		const dt = new Date(value);
		if (Number.isNaN(dt.getTime())) return null;
		const parts = new Intl.DateTimeFormat('fr-FR', {
			timeZone: 'Europe/Paris',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).formatToParts(dt);
		const map = {};
		for (const part of parts) {
			if (part.type !== 'literal') {
				map[part.type] = part.value;
			}
		}
		if (!map.day || !map.month || !map.year || !map.hour || !map.minute) return null;
		return {
			date: `${map.day}-${map.month}-${map.year}`,
			time: `${map.hour}:${map.minute}`
		};
	}

	#parseParisSchedule(dateRaw, timeRaw) {
		const dateMatch = String(dateRaw || '').trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
		const timeMatch = String(timeRaw || '').trim().match(/^(\d{2}):(\d{2})$/);
		if (!dateMatch || !timeMatch) return null;

		const day = Number(dateMatch[1]);
		const month = Number(dateMatch[2]);
		const year = Number(dateMatch[3]);
		const hour = Number(timeMatch[1]);
		const minute = Number(timeMatch[2]);

		if (!this.#isValidDateParts(year, month, day, hour, minute)) return null;

		const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
		if (Number.isNaN(utcGuess.getTime())) return null;
		const offsetMinutes = this.#getTimeZoneOffsetMinutes(utcGuess, 'Europe/Paris');
		const candidate = new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000);
		const parts = this.#formatParisScheduleParts(candidate);
		const expectedDate = `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
		const expectedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
		if (!parts || parts.date !== expectedDate || parts.time !== expectedTime) return null;
		return candidate;
	}

	#getTimeZoneOffsetMinutes(date, timeZone) {
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		}).formatToParts(date);
		const map = {};
		for (const part of parts) {
			if (part.type !== 'literal') {
				map[part.type] = part.value;
			}
		}
		const asUTC = Date.UTC(
			Number(map.year),
			Number(map.month) - 1,
			Number(map.day),
			Number(map.hour),
			Number(map.minute)
		);
		return (asUTC - date.getTime()) / 60000;
	}

	#isValidDateParts(year, month, day, hour, minute) {
		if (!Number.isInteger(year) || year < 2000 || year > 2100) return false;
		if (!Number.isInteger(month) || month < 1 || month > 12) return false;
		if (!Number.isInteger(day) || day < 1 || day > 31) return false;
		if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
		if (!Number.isInteger(minute) || minute < 0 || minute > 59) return false;
		return true;
	}

	#mergePreviewContent(prefix, content) {
		const base = content ? `${prefix}\n\n${content}` : prefix;
		return base.length > 2000 ? `${base.slice(0, 1997)}...` : base;
	}

	#extractImageAttachment(message) {
		const attachments = message?.attachments?.values ? [...message.attachments.values()] : [];
		for (const attachment of attachments) {
			if (attachment?.contentType?.startsWith?.('image/')) return attachment;
			if (attachment?.url && /\.(png|jpe?g|gif|webp)$/i.test(attachment.url)) return attachment;
		}
		return null;
	}

	#setPendingImage({ guildId, userId, channelId, recordId }) {
		if (!guildId || !userId || !recordId) return;
		this.pendingImages.set(`${guildId}:${userId}`, {
			channelId,
			recordId,
			requestedAt: Date.now()
		});
	}

	async #getHubRecord(guildId, userId) {
		const [rows] = await this.db.query(
			'SELECT * FROM hub_channels WHERE guild_id = ? AND user_id = ?',
			[guildId, userId]
		);
		return rows?.[0] || null;
	}

	async #setHubRecord(guildId, userId, channelId, joinMessageId, requestMessageId) {
		await this.db.query(
			`INSERT INTO hub_channels (guild_id, user_id, channel_id, join_message_id, request_message_id)
                         VALUES (?, ?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id),
                                 join_message_id = VALUES(join_message_id),
                                 request_message_id = VALUES(request_message_id)`,
			[guildId, userId, channelId, joinMessageId, requestMessageId]
		);
		return this.#getHubRecord(guildId, userId);
	}

	async #insertRequest(payload) {
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

	async #updateRequest(id, updates) {
		if (!id) return;
		const fields = [];
		const values = [];
		for (const [key, value] of Object.entries(updates || {})) {
			fields.push(`${key} = ?`);
			values.push(value);
		}
		fields.push('updated_at = NOW()');
		values.push(id);
		await this.db.query(`UPDATE hub_requests SET ${fields.join(', ')} WHERE id = ?`, values);
	}

	async #getRequest(id) {
		if (!id) return null;
		const [rows] = await this.db.query('SELECT * FROM hub_requests WHERE id = ?', [id]);
		return rows?.[0] || null;
	}

	async #fetchChannelFromRequest(request) {
		if (!request?.user_id || !request?.guild_id) return null;
		const record = await this.#getHubRecord(request.guild_id, request.user_id);
		if (!record?.channel_id) return null;
		return this.#fetchChannel(record.channel_id);
	}

	async #findExistingHubChannel(guild, userId) {
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

	async #buildHubChannelIndex(guild) {
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

	async #ensureHubCategory(guild) {
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

	async #fetchChannel(id) {
		if (!id) return null;
		try {
			return await this.client.channels.fetch(id);
		} catch {
			return null;
		}
	}

	async #sleep(ms) {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	#getOwnerId() {
		return this.client?.context?.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID || null;
	}

	async #getRequestsChannelId(guildId) {
		if (!guildId) return null;
		const [rows] = await this.db.query('SELECT requests_channel_id FROM settings WHERE guild_id = ?', [guildId]);
		const configured = rows?.[0]?.requests_channel_id;
		return configured || process.env.ZONE_REQUESTS_CHANNEL_ID || null;
	}

	#isOwner(interaction) {
		const ownerId = this.#getOwnerId();
		return ownerId && String(interaction.user.id) === String(ownerId);
	}

	async #notifyUser(userId, payload) {
		if (!payload) return;
		try {
			const user = await this.client.users.fetch(userId);
			await user.send(payload).catch(() => {});
		} catch {}
	}

	async #reply(interaction, payload) {
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

	async #deferReply(interaction) {
		if (!interaction || interaction.deferred || interaction.replied) return;
		try {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral });
		} catch {}
	}
}

module.exports = { HubService };
