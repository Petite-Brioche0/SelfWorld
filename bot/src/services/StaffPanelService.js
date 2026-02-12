const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	PermissionFlagsBits
} = require('discord.js');

const DEFAULT_COLOR = 0x5865f2;

class StaffPanelService {
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
			await message.reply('❌ **Fichier non valide**\n\nMerci d\'envoyer une **image** (formats acceptés : PNG, JPG, GIF, WEBP).').catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: message.author?.id, channelId: message.channel?.id }, 'Failed to send invalid file reply');
			});
			return true;
		}

		this.pendingImages.delete(key);
		await this.#ensureSchema();

		try {
			if (pending.kind === 'announce') {
				await this.db.query('UPDATE staff_announcements SET embed_image = ?, status = ? WHERE id = ?', [
					attachment.url,
					'draft',
					pending.recordId
				]);
				const announcement = await this.#getAnnouncement(pending.recordId);
				if (announcement) {
					const preview = this.#buildAnnouncementPreview(announcement, { ephemeral: false });
					await message.reply(preview).catch((err) => {
						if (err?.code === 10062 || err?.rawError?.code === 10062) return;
						this.logger?.warn({ err, userId: message.author?.id, announcementId: pending.recordId }, 'Failed to send announcement preview');
					});
				}
				return true;
			}

			if (pending.kind === 'event') {
				await this.db.query('UPDATE events SET embed_image = ?, status = ? WHERE id = ?', [
					attachment.url,
					'draft',
					pending.recordId
				]);
				const event = await this.#getEventDraft(pending.recordId);
				if (event) {
					const preview = this.#buildEventPreview(event, { ephemeral: false });
					await message.reply(preview).catch((err) => {
						if (err?.code === 10062 || err?.rawError?.code === 10062) return;
						this.logger?.warn({ err, userId: message.author?.id, eventId: pending.recordId }, 'Failed to send event preview');
					});
					await this.refreshEventMessages(event.id).catch((err) => {
						this.logger?.warn({ err, eventId: event.id }, 'Failed to refresh event messages');
					});
				}
				return true;
			}
		} catch (err) {
			this.logger?.warn({ err, recordId: pending.recordId }, 'Failed to attach image to staff draft');
			await message.reply('❌ **Erreur**\n\nImpossible de récupérer cette image pour le moment. Réessaye avec une autre image.').catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: message.author?.id, channelId: message.channel?.id }, 'Failed to send image attachment error message');
			});
			return true;
		}

		return false;
	}

	async ensureStaffPanels() {
		await this.#ensureSchema();

		const [rows] = await this.db.query(
			'SELECT guild_id, events_admin_channel_id, events_admin_message_id FROM settings WHERE events_admin_channel_id IS NOT NULL'
		);

		for (const row of rows || []) {
			const channelId = row.events_admin_channel_id;
			if (!channelId) continue;
			const channel = await this.client.channels.fetch(channelId).catch(() => null);
			if (!channel?.isTextBased?.()) continue;

			const payload = this.#buildStaffPanelPayload();
			let message = null;
			if (row.events_admin_message_id) {
				message = await channel.messages.fetch(row.events_admin_message_id).catch(() => null);
				if (message) {
					await message.edit(payload).catch((err) => {
						if (err?.code === 10008) return; // Unknown message
						this.logger?.warn({ err, messageId: message?.id, channelId: message?.channelId }, 'Failed to edit staff panel message');
					});
				}
			}

			if (!message) {
				message = await channel.send(payload).catch(() => null);
			}

			if (message) {
				await this.db
					.query('UPDATE settings SET events_admin_message_id = ? WHERE guild_id = ?', [
						message.id,
						row.guild_id
					])
					.catch((err) => {
						this.logger?.warn({ err, guildId: row.guild_id, messageId: message.id }, 'Failed to update staff panel message ID');
					});
			}
		}
	}

	async handleButton(interaction) {
		const id = interaction.customId || '';
		if (!id.startsWith('staff:')) return false;

		if (!this.#isStaff(interaction)) {
			await this.#reply(interaction, { content: '🔒 **Accès réservé**\n\nCette fonctionnalité est réservée aux membres du staff.', flags: MessageFlags.Ephemeral });
			return true;
		}

		if (id === 'staff:panel:refresh') {
			await interaction.deferUpdate().catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer staff panel refresh');
			});
			await this.ensureStaffPanels().catch((err) => {
				this.logger?.warn({ err }, 'Failed to refresh staff panel');
			});
			await this.#followUp(interaction, { content: '✅ **Panneau actualisé**\n\nLe panneau staff a été mis à jour avec succès.', flags: MessageFlags.Ephemeral });
			return true;
		}

		if (id === 'staff:announce:new') {
			const modal = this.#buildAnnouncementModal();
			await interaction.showModal(modal);
			return true;
		}

		if (id.startsWith('staff:announce:edit:')) {
			const announcementId = Number(id.split(':').at(-1));
			const announcement = await this.#getAnnouncement(announcementId);
			if (!announcement) {
				await this.#reply(interaction, { content: '❌ **Annonce introuvable**\n\nCette annonce n\'existe plus ou a été supprimée.', flags: MessageFlags.Ephemeral });
				return true;
			}
			const modal = this.#buildAnnouncementModal(announcement);
			await interaction.showModal(modal);
			return true;
		}

		if (id.startsWith('staff:announce:send:')) {
			const announcementId = Number(id.split(':').at(-1));
			await interaction.deferUpdate().catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, announcementId }, 'Failed to defer announcement send');
			});
			const announcement = await this.#getAnnouncement(announcementId);
			if (!announcement) {
				await this.#followUp(interaction, { content: '❌ **Annonce introuvable**\n\nCette annonce n\'existe plus ou a été supprimée.', flags: MessageFlags.Ephemeral });
				return true;
			}
			try {
				await this.#sendAnnouncementNow(announcement, interaction.user.id);
				await this.#followUp(interaction, { content: '✅ **Annonce envoyée**\n\nTon annonce a été diffusée avec succès à toutes les zones.', flags: MessageFlags.Ephemeral });
			} catch (err) {
				this.logger?.warn({ err, announcementId }, 'Failed to send announcement');
				await this.#followUp(interaction, {
					content: '❌ **Erreur d\'envoi**\n\nImpossible d\'envoyer l\'annonce pour le moment. Réessaye dans quelques instants.',
					flags: MessageFlags.Ephemeral
				});
			}
			return true;
		}

		if (id.startsWith('staff:announce:schedule:')) {
			const announcementId = Number(id.split(':').at(-1));
			const announcement = await this.#getAnnouncement(announcementId);
			if (!announcement) {
				await this.#reply(interaction, { content: '❌ **Annonce introuvable**\n\nCette annonce n\'existe plus ou a été supprimée.', flags: MessageFlags.Ephemeral });
				return true;
			}
			const modal = this.#buildScheduleModal('announce', announcement);
			await interaction.showModal(modal);
			return true;
		}

		if (id === 'staff:event:new') {
			const modal = this.#buildEventModal();
			await interaction.showModal(modal);
			return true;
		}

		if (id.startsWith('staff:event:edit:')) {
			const eventId = Number(id.split(':').at(-1));
			const event = await this.#getEventDraft(eventId);
			if (!event) {
				await this.#reply(interaction, { content: '❌ **Événement introuvable**\n\nCet événement n\'existe plus ou a été supprimé.', flags: MessageFlags.Ephemeral });
				return true;
			}
			const modal = this.#buildEventModal(event);
			await interaction.showModal(modal);
			return true;
		}

		if (id.startsWith('staff:event:send:')) {
			const eventId = Number(id.split(':').at(-1));
			await interaction.deferUpdate().catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, eventId }, 'Failed to defer event send');
			});
			const event = await this.#getEventDraft(eventId);
			if (!event) {
				await this.#followUp(interaction, { content: '❌ **Événement introuvable**\n\nCet événement n\'existe plus ou a été supprimé.', flags: MessageFlags.Ephemeral });
				return true;
			}
			try {
				await this.#activateEvent(event, interaction.user.id);
				await this.#followUp(interaction, { content: '✅ **Événement activé**\n\nTon événement a été publié avec succès et la zone temporaire est maintenant active.', flags: MessageFlags.Ephemeral });
			} catch (err) {
				this.logger?.warn({ err, eventId }, 'Failed to send event');
				await this.#followUp(interaction, {
					content: '❌ **Erreur d\'activation**\n\nImpossible d\'activer l\'événement pour le moment. Réessaye dans quelques instants.',
					flags: MessageFlags.Ephemeral
				});
			}
			return true;
		}

		if (id.startsWith('staff:event:schedule:')) {
			const eventId = Number(id.split(':').at(-1));
			const event = await this.#getEventDraft(eventId);
			if (!event) {
				await this.#reply(interaction, { content: '❌ **Événement introuvable**\n\nCet événement n\'existe plus ou a été supprimé.', flags: MessageFlags.Ephemeral });
				return true;
			}
			const modal = this.#buildScheduleModal('event', event);
			await interaction.showModal(modal);
			return true;
		}

		await this.#reply(interaction, { content: '❌ **Action inconnue**\n\nCette action n\'est pas reconnue par le système.', flags: MessageFlags.Ephemeral });
		return true;
	}

	async handleModal(interaction) {
		const id = interaction.customId || '';
		if (!id.startsWith('staff:')) return false;

		if (!this.#isStaff(interaction)) {
			await this.#reply(interaction, { content: '🔒 **Accès réservé**\n\nCette fonctionnalité est réservée aux membres du staff.', flags: MessageFlags.Ephemeral });
			return true;
		}

		if (id.startsWith('staff:announce:modal')) {
			await this.#handleAnnouncementModal(interaction);
			return true;
		}

		if (id.startsWith('staff:announce:schedule:modal:')) {
			await this.#handleScheduleModal(interaction, 'announce');
			return true;
		}

		if (id.startsWith('staff:event:modal')) {
			await this.#handleEventModal(interaction);
			return true;
		}

		if (id.startsWith('staff:event:schedule:modal:')) {
			await this.#handleScheduleModal(interaction, 'event');
			return true;
		}

		return false;
	}

	async processScheduled() {
		if (this.#processing) return;
		this.#processing = true;
		try {
			await this.#processScheduledAnnouncements();
			await this.#processScheduledEvents();
		} finally {
			this.#processing = false;
		}
	}

	async submitAnnouncementFromRequest(request, actorId) {
		await this.#ensureSchema();
		if (!request?.guild_id) throw new Error('Guild missing');

		const now = Date.now();
		let scheduledAt = request.scheduled_at ? new Date(request.scheduled_at) : null;
		if (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now) {
			scheduledAt = null;
		}

		const payload = {
			guild_id: request.guild_id,
			author_id: request.user_id || actorId,
			content: request.content || null,
			embed_title: request.embed_title || null,
			embed_description: request.embed_description || null,
			embed_color: request.embed_color || null,
			embed_image: request.embed_image || null,
			scheduled_at: scheduledAt
		};

		const id = await this.#insertAnnouncement(payload);
		const announcement = await this.#getAnnouncement(id);
		if (scheduledAt) {
			await this.#scheduleAnnouncement(id, scheduledAt, actorId);
		} else {
			await this.#sendAnnouncementNow(announcement, actorId);
		}
		return id;
	}

	async submitEventFromRequest(request, actorId) {
		await this.#ensureSchema();
		if (!request?.guild_id) throw new Error('Guild missing');

		const now = Date.now();
		let scheduledAt = request.scheduled_at ? new Date(request.scheduled_at) : null;
		if (!scheduledAt || Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() <= now) {
			scheduledAt = null;
		}

		const payload = {
			guild_id: request.guild_id,
			created_by: request.user_id || actorId,
			name: request.embed_title || 'Evenement',
			description: request.embed_description || null,
			message_content: request.message_content || null,
			embed_color: request.embed_color || null,
			embed_image: request.embed_image || null,
			game: request.game || null,
			min_participants: request.min_participants || null,
			max_participants: request.max_participants || null,
			scheduled_at: scheduledAt
		};

		const id = await this.#insertEventDraft(payload);
		const event = await this.#getEventDraft(id);
		if (scheduledAt) {
			await this.#scheduleEvent(id, scheduledAt, actorId);
		} else {
			await this.#activateEvent(event, actorId);
		}

		const updated = await this.#getEventDraft(id);
		const tempGroupService = this.services?.tempGroup || this.client?.context?.services?.tempGroup;
		if (updated?.temp_group_id && request.user_id && tempGroupService?.setMemberRole) {
			try {
				if (tempGroupService?.setGroupOwner) {
					await tempGroupService.setGroupOwner(updated.temp_group_id, request.user_id);
				}
				await tempGroupService.setMemberRole(updated.temp_group_id, request.user_id, 'participant', {
					guildId: request.guild_id,
					allowPanel: true
				});
			} catch (err) {
				this.logger?.warn({ err, eventId: id, userId: request.user_id }, 'Failed to grant temp group access');
			}
			if (tempGroupService?.grantPanelAccess) {
				try {
					await tempGroupService.grantPanelAccess(updated.temp_group_id, request.user_id, {
						guildId: request.guild_id
					});
				} catch (err) {
					this.logger?.warn({ err, eventId: id, userId: request.user_id }, 'Failed to grant panel access');
				}
			}
		}
		return id;
	}

	// ==== Modals

	#buildAnnouncementModal(existing = null) {
		const modal = new ModalBuilder()
			.setCustomId(`staff:announce:modal${existing?.id ? `:${existing.id}` : ''}`)
			.setTitle('Composer une annonce');

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
			.setMaxLength(8)
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

	#buildEventModal(existing = null) {
		const modal = new ModalBuilder()
			.setCustomId(`staff:event:modal${existing?.id ? `:${existing.id}` : ''}`)
			.setTitle('Créer un événement');

		const contentInput = new TextInputBuilder()
			.setCustomId('eventContent')
			.setLabel('Contenu')
			.setStyle(TextInputStyle.Paragraph)
			.setRequired(false)
			.setMaxLength(4000)
			.setValue(existing?.description || '');

		const nameInput = new TextInputBuilder()
			.setCustomId('eventName')
			.setLabel('Titre')
			.setStyle(TextInputStyle.Short)
			.setRequired(true)
			.setMaxLength(120)
			.setValue(existing?.name || '');

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

	#buildScheduleModal(kind, record) {
		const modal = new ModalBuilder()
			.setCustomId(`staff:${kind}:schedule:modal:${record.id}`)
			.setTitle(kind === 'announce' ? 'Programmer une annonce' : 'Programmer un événement');

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

		if (record?.scheduled_at) {
			const parts = this.#formatParisScheduleParts(record.scheduled_at);
			if (parts?.date) dateInput.setValue(parts.date);
			if (parts?.time) timeInput.setValue(parts.time);
		}

		modal.addComponents(
			new ActionRowBuilder().addComponents(dateInput),
			new ActionRowBuilder().addComponents(timeInput)
		);

		return modal;
	}

	// ==== Announcements

	async #handleAnnouncementModal(interaction) {
		try {
			await this.#ensureSchema();
			const customId = interaction.customId;
			const existingId = Number(customId.split(':').at(-1));

			const existing = existingId ? await this.#getAnnouncement(existingId) : null;

			const embedTitle = interaction.fields.getTextInputValue('announceTitle')?.trim() || null;
			const embedDescription = interaction.fields.getTextInputValue('announceContent')?.trim() || null;
			const colorRaw = interaction.fields.getTextInputValue('announceColor')?.trim() || '';
			const tagRaw = interaction.fields.getTextInputValue('announceTag')?.trim() || '';
			const tagValue = tagRaw ? tagRaw.slice(0, 128) : '';
			const imageRaw = interaction.fields.getTextInputValue('announceImage')?.trim() || '';

			const embedColor = colorRaw ? this.#normalizeColor(colorRaw) : null;
			if (colorRaw && !embedColor) {
				await this.#reply(interaction, {
					content: '❌ **Couleur invalide**\n\n' +
						'Utilise le format hexadécimal : `#RRGGBB`\n\n' +
						'**Exemples :**\n' +
						'• `#5865F2` - Bleu Discord\n' +
						'• `#FF5733` - Orange\n' +
						'• `#9B59B6` - Violet\n' +
						'• `#2ECC71` - Vert',
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
				author_id: interaction.user.id,
				content: tagValue || null,
				embed_title: embedTitle,
				embed_description: embedDescription,
				embed_color: embedColor,
				embed_image: embedImage,
				scheduled_at: existing?.scheduled_at || null
			};

			let announcement = null;
			if (existingId) {
				await this.#updateAnnouncement(existingId, payload);
				announcement = await this.#getAnnouncement(existingId);
			} else {
				const id = await this.#insertAnnouncement(payload);
				announcement = await this.#getAnnouncement(id);
			}

			if (pendingImage) {
				this.#setPendingImage({
					guildId: interaction.guildId,
					userId: interaction.user.id,
					channelId: interaction.channelId,
					kind: 'announce',
					recordId: announcement.id
				});
				await this.#reply(interaction, {
					content: '🖼️ **Image requise**\n\n' +
						'Envoie ton image dans ce salon maintenant.\n' +
						'Formats acceptés : PNG, JPG, GIF, WEBP\n\n' +
						'> ⏰ *Tu as 10 minutes pour l\'envoyer.*',
					flags: MessageFlags.Ephemeral
				});
				return;
			}

			const preview = this.#buildAnnouncementPreview(announcement, { ephemeral: true });
			await this.#reply(interaction, preview);
		} catch (err) {
			this.logger?.warn({ err }, 'Failed to handle announcement modal');
			await this.#reply(interaction, {
				content: '❌ **Erreur**\n\n' +
					'Impossible de préparer ton annonce pour le moment.\n' +
					'Réessaye dans quelques instants.',
				flags: MessageFlags.Ephemeral
			});
		}
	}

	async #insertAnnouncement(payload) {
		const [res] = await this.db.query(
			`INSERT INTO staff_announcements
                         (guild_id, author_id, content, embed_title, embed_description, embed_color, embed_image, scheduled_at, status)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
			[
				payload.guild_id,
				payload.author_id,
				payload.content,
				payload.embed_title,
				payload.embed_description,
				payload.embed_color,
				payload.embed_image,
				payload.scheduled_at
			]
		);
		return res.insertId;
	}

	async #updateAnnouncement(id, payload) {
		await this.db.query(
			`UPDATE staff_announcements
                         SET content = ?, embed_title = ?, embed_description = ?, embed_color = ?, embed_image = ?, scheduled_at = ?, status = 'draft'
                         WHERE id = ?`,
			[
				payload.content,
				payload.embed_title,
				payload.embed_description,
				payload.embed_color,
				payload.embed_image,
				payload.scheduled_at,
				id
			]
		);
	}

	async #getAnnouncement(id) {
		const [rows] = await this.db.query('SELECT * FROM staff_announcements WHERE id = ?', [id]);
		return rows?.[0] || null;
	}

	#buildAnnouncementPreview(announcement, { ephemeral = true } = {}) {
		const payload = this.#buildAnnouncementPayload(announcement);
		const components = this.#buildDraftActions('announce', announcement);
		const content = announcement.scheduled_at
			? `Prévisualisation. Date prévue : ${this.#formatSchedule(announcement.scheduled_at)}`
			: 'Prévisualisation.';
		const mergedContent = this.#mergePreviewContent(content, payload.content);

		const preview = {
			content: mergedContent,
			embeds: payload.embeds,
			components
		};
		if (ephemeral) {
			preview.flags = MessageFlags.Ephemeral;
		}
		return preview;
	}

	#buildAnnouncementPayload(announcement) {
		const embeds = [];
		const embed = new EmbedBuilder();
		let hasEmbed = false;

		const contentParts = [];
		if (announcement.content) contentParts.push(announcement.content);

		if (announcement.embed_title) {
			embed.setTitle(announcement.embed_title.slice(0, 256));
			hasEmbed = true;
		}
		if (announcement.embed_description) {
			embed.setDescription(announcement.embed_description.slice(0, 4096));
			hasEmbed = true;
		}

		const color = this.#resolveColor(announcement.embed_color) || DEFAULT_COLOR;
		embed.setColor(color);
		hasEmbed = true;

		if (announcement.embed_image) {
			embed.setImage(announcement.embed_image);
			hasEmbed = true;
		}

		if (hasEmbed) {
			embeds.push(embed);
		}

		const content = contentParts.length ? contentParts.join('\n') : null;
		return { content, embeds };
	}

	async #sendAnnouncementNow(announcement, actorId) {
		await this.#ensureSchema();
		if (!announcement) return;

		const payload = this.#buildAnnouncementPayload(announcement);
		if (!payload.content && (!payload.embeds || !payload.embeds.length)) {
			throw new Error('❌ **Annonce vide**\n\nL\'annonce doit contenir au minimum un titre ou du contenu.');
		}

		const [zones] = await this.db.query(
			'SELECT text_reception_id FROM zones WHERE guild_id = ? AND text_reception_id IS NOT NULL',
			[announcement.guild_id]
		);

		let sentCount = 0;
		for (const zone of zones || []) {
			const channelId = zone.text_reception_id;
			if (!channelId) continue;
			const channel = await this.client.channels.fetch(channelId).catch(() => null);
			if (!channel?.isTextBased?.()) continue;
			try {
				await channel.send(payload);
				sentCount += 1;
			} catch (err) {
				this.logger?.warn({ err, channelId }, 'Failed to send announcement to zone reception');
			}
		}

		await this.db.query(
			'UPDATE staff_announcements SET status = ?, sent_at = NOW(), scheduled_at = NULL WHERE id = ?',
			['sent', announcement.id]
		);

		this.logger?.info({ announcementId: announcement.id, actorId, sentCount }, 'Announcement sent');
	}

	async #scheduleAnnouncement(id, scheduledAt, actorId) {
		await this.db.query(
			'UPDATE staff_announcements SET status = ?, scheduled_at = ? WHERE id = ?',
			['scheduled', scheduledAt, id]
		);
		this.logger?.info({ announcementId: id, actorId, scheduledAt }, 'Announcement scheduled');
	}

	// ==== Events

	async #handleEventModal(interaction) {
		try {
			await this.#ensureSchema();
			const customId = interaction.customId;
			const existingId = Number(customId.split(':').at(-1));

			const existing = existingId ? await this.#getEventDraft(existingId) : null;

			const name = interaction.fields.getTextInputValue('eventName')?.trim() || '';
			const description = interaction.fields.getTextInputValue('eventContent')?.trim() || null;
			const colorRaw = interaction.fields.getTextInputValue('eventColor')?.trim() || '';
			const participantsRaw = interaction.fields.getTextInputValue('eventParticipants')?.trim() || '';
			const optionsRaw = interaction.fields.getTextInputValue('eventOptions') || '';
			const options = this.#parseOptions(optionsRaw);

			const embedColor = colorRaw ? this.#normalizeColor(colorRaw) : null;
			if (colorRaw && !embedColor) {
				await this.#reply(interaction, {
					content: '❌ **Couleur invalide**\n\n' +
						'Utilise le format hexadécimal : `#RRGGBB`\n\n' +
						'**Exemples :**\n' +
						'• `#5865F2` - Bleu Discord\n' +
						'• `#FF5733` - Orange\n' +
						'• `#9B59B6` - Violet\n' +
						'• `#2ECC71` - Vert',
					flags: MessageFlags.Ephemeral
				});
				return;
			}

			const gameRaw = options.jeu || options['jeu.x'] || options.game || options.jeux || '';
			const game = gameRaw ? String(gameRaw).trim().slice(0, 120) : null;
			const tagRaw = options.tag || options.type || '';
			const tagValue = tagRaw ? String(tagRaw).trim().slice(0, 128) : null;
			const imageRaw = options.image || options.img || '';

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

			if (!name) {
				await this.#reply(interaction, { content: '❌ **Titre manquant**\n\nLe titre de l\'événement est **obligatoire**.\nMerci de remplir ce champ.', flags: MessageFlags.Ephemeral });
				return;
			}

			const payload = {
				guild_id: interaction.guildId,
				created_by: interaction.user.id,
				name,
				description,
				message_content: tagValue || null,
				embed_color: embedColor,
				embed_image: embedImage,
				game,
				min_participants: participantLimits.min,
				max_participants: participantLimits.max,
				scheduled_at: existing?.scheduled_at || null
			};

			let event = null;
			if (existingId) {
				await this.#updateEventDraft(existingId, payload);
				event = await this.#getEventDraft(existingId);
			} else {
				const id = await this.#insertEventDraft(payload);
				event = await this.#getEventDraft(id);
			}

			if (pendingImage) {
				this.#setPendingImage({
					guildId: interaction.guildId,
					userId: interaction.user.id,
					channelId: interaction.channelId,
					kind: 'event',
					recordId: event.id
				});
				await this.#reply(interaction, {
					content: '🖼️ **Image requise**\n\n' +
						'Envoie ton image dans ce salon maintenant.\n' +
						'Formats acceptés : PNG, JPG, GIF, WEBP\n\n' +
						'> ⏰ *Tu as 10 minutes pour l\'envoyer.*',
					flags: MessageFlags.Ephemeral
				});
				return;
			}

			const preview = this.#buildEventPreview(event, { ephemeral: true });
			await this.#reply(interaction, preview);
			await this.refreshEventMessages(event.id).catch((err) => {
				this.logger?.warn({ err, eventId: event.id }, 'Failed to refresh event messages after modal');
			});
		} catch (err) {
			this.logger?.warn({ err }, 'Failed to handle event modal');
			await this.#reply(interaction, {
				content: '❌ **Erreur**\n\n' +
					'Impossible de préparer ton événement pour le moment.\n' +
					'Réessaye dans quelques instants.',
				flags: MessageFlags.Ephemeral
			});
		}
	}

	async #handleScheduleModal(interaction, kind) {
		try {
			await this.#ensureSchema();
			const parts = interaction.customId.split(':');
			const recordId = Number(parts.at(-1));
			if (!recordId) {
				await this.#reply(interaction, { content: '❌ **Identifiant invalide**\n\nL\'identifiant de la demande est manquant ou incorrect.', flags: MessageFlags.Ephemeral });
				return;
			}

			const dateRaw = interaction.fields.getTextInputValue('scheduleDate')?.trim() || '';
			const timeRaw = interaction.fields.getTextInputValue('scheduleTime')?.trim() || '';
			const scheduledAt = this.#parseParisSchedule(dateRaw, timeRaw);
			if (!scheduledAt) {
				await this.#reply(interaction, {
					content: '❌ **Date ou heure invalide**\n\n' +
						'**Format attendu :**\n' +
						'• Date : `JJ-MM-AAAA` (ex: 15-02-2026)\n' +
						'• Heure : `HH:MM` (ex: 18:30)\n\n' +
						'> 🕐 *L\'heure doit être au fuseau horaire de Paris*',
					flags: MessageFlags.Ephemeral
				});
				return;
			}

			if (kind === 'announce') {
				await this.#scheduleAnnouncement(recordId, scheduledAt, interaction.user.id);
			} else if (kind === 'event') {
				await this.#scheduleEvent(recordId, scheduledAt, interaction.user.id);
			}

			await this.#reply(interaction, {
				content: `⏰ **Publication programmée**\n\n` +
					`📅 Date prévue : **${this.#formatSchedule(scheduledAt)}** (heure de Paris)\n\n` +
					`L'annonce ou événement sera publié automatiquement à cette date.`,
				flags: MessageFlags.Ephemeral
			});
		} catch (err) {
			this.logger?.warn({ err, kind }, 'Failed to schedule from modal');
			await this.#reply(interaction, {
				content: '❌ **Erreur de programmation**\n\nImpossible de programmer pour le moment. Réessaye dans quelques instants.',
				flags: MessageFlags.Ephemeral
			});
		}
	}

	async #insertEventDraft(payload) {
		const [res] = await this.db.query(
			`INSERT INTO events
                         (guild_id, name, description, status, scheduled_at, created_by, message_content, embed_color, embed_image, game, min_participants, max_participants)
                         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
			[
				payload.guild_id,
				payload.name,
				payload.description,
				payload.scheduled_at,
				payload.created_by,
				payload.message_content,
				payload.embed_color,
				payload.embed_image,
				payload.game,
				payload.min_participants,
				payload.max_participants
			]
		);

		return res.insertId;
	}

	async #updateEventDraft(id, payload) {
		await this.db.query(
			`UPDATE events
                         SET name = ?, description = ?, scheduled_at = ?, created_by = ?, message_content = ?, embed_color = ?, embed_image = ?, game = ?, min_participants = ?, max_participants = ?, status = 'draft'
                         WHERE id = ?`,
			[
				payload.name,
				payload.description,
				payload.scheduled_at,
				payload.created_by,
				payload.message_content,
				payload.embed_color,
				payload.embed_image,
				payload.game,
				payload.min_participants,
				payload.max_participants,
				id
			]
		);
	}

	async #getEventDraft(id) {
		const [rows] = await this.db.query('SELECT * FROM events WHERE id = ?', [id]);
		return rows?.[0] || null;
	}

	#buildEventPreview(event, { ephemeral = true } = {}) {
		const payload = this.#buildEventPayload(event, null);
		const components = this.#buildDraftActions('event', event);
		const content = event.scheduled_at
			? `Prévisualisation. Date prévue : ${this.#formatSchedule(event.scheduled_at)}`
			: 'Prévisualisation.';

		const preview = {
			content,
			embeds: payload.embeds,
			components
		};
		if (ephemeral) {
			preview.flags = MessageFlags.Ephemeral;
		}
		return preview;
	}

	#buildEventPayload(event, eventId, { disableJoin = false } = {}) {
		const embeds = [];
		const embed = new EmbedBuilder()
			.setTitle(event.name?.slice(0, 256) || 'Événement')
			.setDescription(event.description?.slice(0, 4096) || 'Rejoins le groupe pour participer.');

		const minPart = event.min_participants ? Number(event.min_participants) : null;
		const maxPart = event.max_participants ? Number(event.max_participants) : null;
		if (minPart || maxPart) {
			const label = [
				minPart ? `min ${minPart}` : null,
				maxPart ? `max ${maxPart}` : null
			].filter(Boolean).join(' / ');
			embed.addFields({ name: 'Participants', value: label || '—', inline: false });
		}

		const registeredCount = Number(event.participant_count);
		if (Number.isFinite(registeredCount)) {
			const maxLabel = maxPart ? ` / ${maxPart}` : '';
			embed.addFields({ name: 'Inscrits', value: `${registeredCount}${maxLabel}`, inline: false });
		}

		if (event.message_content) {
			embed.setFooter({ text: `Type: ${String(event.message_content).slice(0, 2000)}` });
		}

		if (event.game) {
			embed.addFields({ name: 'Jeu', value: String(event.game).slice(0, 256), inline: false });
		}

		if (event.embed_image) {
			embed.setImage(event.embed_image);
		}

		const color = this.#resolveColor(event.embed_color) || DEFAULT_COLOR;
		embed.setColor(color);
		embeds.push(embed);

		const components = [];
		if (eventId) {
			const row = new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`event:join:${eventId}`)
					.setLabel('Rejoindre l\'evenement')
					.setStyle(ButtonStyle.Primary)
					.setDisabled(disableJoin),
				new ButtonBuilder()
					.setCustomId(`event:spectate:${eventId}`)
					.setLabel('Spectateur')
					.setStyle(ButtonStyle.Secondary)
			);
			components.push(row);
		}

		return { embeds, components };
	}

	async #scheduleEvent(id, scheduledAt, actorId) {
		const event = await this.#getEventDraft(id);
		if (!event) {
			throw new Error('Événement introuvable');
		}

		let tempGroupId = event.temp_group_id || null;
		const tempGroupService = this.services?.tempGroup || this.client?.context?.services?.tempGroup;
		const durationHours = this.#resolveEventDurationHours();
		const expiry = new Date(scheduledAt.getTime() + durationHours * 60 * 60 * 1000);

		if (tempGroupService?.createGroup && event.guild_id) {
			let group = null;
			if (tempGroupId && tempGroupService.getGroup) {
				group = await tempGroupService.getGroup(tempGroupId).catch(() => null);
				if (group?.archived) {
					group = null;
				}
			}

			if (!group) {
				const created = await tempGroupService.createGroup({
					guildId: event.guild_id,
					name: event.name,
					expiresAt: expiry,
					createdBy: actorId,
					eventId: event.id
				});
				tempGroupId = created?.id || null;
			} else if (tempGroupService.updateExpiry) {
				await tempGroupService.updateExpiry(group.id, expiry).catch((err) => {
					this.logger?.warn({ err, groupId: group.id, eventId: event.id }, 'Failed to update temp group expiry during scheduling');
				});
				tempGroupId = group.id;
			}
		}

		await this.db.query(
			'UPDATE events SET status = ?, scheduled_at = ?, temp_group_id = ? WHERE id = ?',
			['scheduled', scheduledAt, tempGroupId, id]
		);
		this.logger?.info({ eventId: id, actorId, scheduledAt, tempGroupId }, 'Event scheduled');
	}

	async #activateEvent(event, actorId) {
		await this.#ensureSchema();
		if (!event) return;
		const guildId = event.guild_id;
		const guild = await this.client.guilds.fetch(guildId).catch(() => null);
		if (!guild) throw new Error('Guilde introuvable');

		const start = event.scheduled_at ? new Date(event.scheduled_at) : new Date();
		let end = event.ends_at ? new Date(event.ends_at) : null;
		if (!end || end <= start) {
			const hours = this.#resolveEventDurationHours();
			end = new Date(start.getTime() + hours * 60 * 60 * 1000);
		}

		const tempGroupService = this.services?.tempGroup || this.client?.context?.services?.tempGroup;
		if (!tempGroupService?.createGroup) {
			throw new Error('TempGroupService indisponible');
		}

		let group = null;
		if (event.temp_group_id && tempGroupService.getGroup) {
			group = await tempGroupService.getGroup(event.temp_group_id).catch(() => null);
			if (group?.archived) {
				group = null;
			}
		}

		if (!group) {
			group = await tempGroupService.createGroup({
				guildId,
				name: event.name,
				expiresAt: end,
				createdBy: actorId,
				eventId: event.id
			});
		} else if (tempGroupService.updateExpiry) {
			await tempGroupService.updateExpiry(group.id, end).catch((err) => {
				this.logger?.warn({ err, groupId: group.id, eventId: event.id }, 'Failed to update temp group expiry during activation');
			});
		}

		await this.db.query(
			'UPDATE events SET status = ?, starts_at = ?, ends_at = ?, temp_group_id = ?, scheduled_at = NULL WHERE id = ?',
			['running', start, end, group?.id || event.temp_group_id || null, event.id]
		);

		const [zones] = await this.db.query(
			'SELECT text_reception_id FROM zones WHERE guild_id = ? AND text_reception_id IS NOT NULL',
			[guildId]
		);

		const participantCount = await this.#countEventParticipants(event.id);
		const maxParticipants = Number(event.max_participants || 0);
		const disableJoin = Number.isFinite(maxParticipants) && maxParticipants > 0 && participantCount >= maxParticipants;
		const payload = this.#buildEventPayload(
			{ ...event, starts_at: start, ends_at: end, participant_count: participantCount },
			event.id,
			{ disableJoin }
		);

		let sentCount = 0;
		for (const zone of zones || []) {
			const channelId = zone.text_reception_id;
			if (!channelId) continue;
			const channel = await this.client.channels.fetch(channelId).catch(() => null);
			if (!channel?.isTextBased?.()) continue;
			try {
				const message = await channel.send(payload);
				if (message?.id) {
					await this.#recordEventMessage(event.id, channelId, message.id);
				}
				sentCount += 1;
			} catch (err) {
				this.logger?.warn({ err, channelId }, 'Failed to send event to zone reception');
			}
		}

		this.logger?.info({ eventId: event.id, actorId, sentCount }, 'Event activated');
	}

	async #recordEventMessage(eventId, channelId, messageId) {
		if (!eventId || !channelId || !messageId) return;
		await this.db.query(
			`INSERT INTO event_messages (event_id, channel_id, message_id)
                         VALUES (?, ?, ?)
                         ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)`,
			[eventId, channelId, messageId]
		).catch((err) => {
			this.logger?.warn({ err, eventId, channelId, messageId }, 'Failed to record event message');
		});
	}

	async refreshEventMessages(eventId) {
		if (!eventId) return { ok: false, message: '❌ **Événement introuvable**\n\nCet événement n\'existe plus ou a été supprimé.' };
		await this.#ensureSchema();

		const event = await this.#getEventDraft(eventId);
		if (!event) return { ok: false, message: '❌ **Événement introuvable**\n\nCet événement n\'existe plus ou a été supprimé.' };

		const participantCount = await this.#countEventParticipants(eventId);
		const maxParticipants = Number(event.max_participants || 0);
		const disableJoin = Number.isFinite(maxParticipants) && maxParticipants > 0 && participantCount >= maxParticipants;
		const payload = this.#buildEventPayload(
			{ ...event, participant_count: participantCount },
			eventId,
			{ disableJoin }
		);

		const [rows] = await this.db.query(
			'SELECT channel_id, message_id FROM event_messages WHERE event_id = ?',
			[eventId]
		);

		let updated = 0;
		for (const row of rows || []) {
			const channel = await this.client.channels.fetch(row.channel_id).catch(() => null);
			if (!channel?.isTextBased?.()) {
				await this.db.query('DELETE FROM event_messages WHERE event_id = ? AND channel_id = ?', [
					eventId,
					row.channel_id
				]).catch((err) => {
					this.logger?.warn({ err, eventId, channelId: row.channel_id }, 'Failed to delete event message record for invalid channel');
				});
				continue;
			}
			const message = await channel.messages.fetch(row.message_id).catch(() => null);
			if (!message) {
				await this.db.query('DELETE FROM event_messages WHERE event_id = ? AND channel_id = ?', [
					eventId,
					row.channel_id
				]).catch((err) => {
					this.logger?.warn({ err, eventId, channelId: row.channel_id, messageId: row.message_id }, 'Failed to delete event message record for missing message');
				});
				continue;
			}
			await message.edit(payload).catch((err) => {
				if (err?.code === 10008) return; // Unknown message
				this.logger?.warn({ err, messageId: message?.id, channelId: message?.channelId, eventId }, 'Failed to edit event message');
			});
			updated += 1;
		}

		const tempGroupService = this.services?.tempGroup || this.client?.context?.services?.tempGroup;
		if (tempGroupService?.getGroup && tempGroupService?.ensurePanel && event.temp_group_id) {
			const group = await tempGroupService.getGroup(event.temp_group_id).catch(() => null);
			if (group) {
				await tempGroupService.ensurePanel(group).catch((err) => {
					this.logger?.warn({ err, groupId: group.id, eventId }, 'Failed to ensure temp group panel');
				});
			}
		}

		return { ok: true, updated };
	}

	// ==== Scheduled processors

	async #processScheduledAnnouncements() {
		await this.#ensureSchema();
		const [rows] = await this.db.query(
			"SELECT * FROM staff_announcements WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 10"
		);
		const now = Date.now();
		for (const announcement of rows || []) {
			const scheduledAt = announcement.scheduled_at ? new Date(announcement.scheduled_at) : null;
			if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
				this.logger?.warn({ announcementId: announcement.id }, 'Scheduled announcement missing date');
				continue;
			}
			if (scheduledAt.getTime() > now) break;
			try {
				await this.#sendAnnouncementNow(announcement, announcement.author_id);
			} catch (err) {
				this.logger?.warn({ err, announcementId: announcement.id }, 'Failed to send scheduled announcement');
			}
		}
	}

	async #processScheduledEvents() {
		await this.#ensureSchema();
		const [rows] = await this.db.query(
			"SELECT * FROM events WHERE status = 'scheduled' ORDER BY scheduled_at ASC LIMIT 10"
		);
		const now = Date.now();
		for (const event of rows || []) {
			const scheduledAt = event.scheduled_at ? new Date(event.scheduled_at) : null;
			if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
				this.logger?.warn({ eventId: event.id }, 'Scheduled event missing date');
				continue;
			}
			if (scheduledAt.getTime() > now) break;
			try {
				await this.#activateEvent(event, event.created_by);
			} catch (err) {
				this.logger?.warn({ err, eventId: event.id }, 'Failed to activate scheduled event');
			}
		}
	}

	// ==== Helpers

	#buildDraftActions(kind, record) {
		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`staff:${kind}:edit:${record.id}`)
				.setLabel('Modifier')
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`staff:${kind}:send:${record.id}`)
				.setLabel('Envoyer maintenant')
				.setStyle(ButtonStyle.Primary),
			new ButtonBuilder()
				.setCustomId(`staff:${kind}:schedule:${record.id}`)
				.setLabel('Programmer')
				.setStyle(ButtonStyle.Secondary)
		);

		return [row];
	}

	#buildStaffPanelPayload() {
		const embed = new EmbedBuilder()
			.setTitle('📣 Annonces staff → zones')
			.setDescription(
				[
					'Prépare et diffuse un message vers chaque salon #reception des zones.',
					'Tu peux composer une annonce ou créer un événement avec un groupe temporaire.'
				].join('\n')
			)
			.setColor(DEFAULT_COLOR);

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId('staff:announce:new').setLabel('Composer une annonce').setStyle(ButtonStyle.Primary),
			new ButtonBuilder().setCustomId('staff:event:new').setLabel('Créer un événement').setStyle(ButtonStyle.Secondary)
		);

		return { embeds: [embed], components: [row] };
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

	#formatParticipants(existing) {
		if (!existing) return '';
		const min = existing.min_participants ? Number(existing.min_participants) : null;
		const max = existing.max_participants ? Number(existing.max_participants) : null;
		if (!min && !max) return '';
		if (min && max) return `min=${min} max=${max}`;
		if (min) return `min=${min}`;
		return `max=${max}`;
	}

	async #countEventParticipants(eventId) {
		if (!eventId) return 0;
		try {
			const [rows] = await this.db.query(
				"SELECT COUNT(*) AS n FROM event_participants WHERE event_id = ? AND role = 'participant'",
				[eventId]
			);
			return Number(rows?.[0]?.n || 0);
		} catch (_err) {
			try {
				const [rows] = await this.db.query(
					'SELECT COUNT(*) AS n FROM event_participants WHERE event_id = ?',
					[eventId]
				);
				return Number(rows?.[0]?.n || 0);
			} catch (inner) {
				this.logger?.warn({ err: inner, eventId }, 'Failed to count event participants');
				return 0;
			}
		}
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

	#resolveEventDurationHours() {
		const raw = Number(process.env.EVENT_DURATION_HOURS);
		return Number.isFinite(raw) && raw > 0 ? raw : 24;
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

	#isAffirmative(value) {
		const trimmed = String(value || '').trim().toLowerCase();
		return ['oui', 'yes', 'y', 'true', '1'].includes(trimmed);
	}

	#setPendingImage({ guildId, userId, channelId, kind, recordId }) {
		if (!guildId || !userId || !recordId) return;
		const key = `${guildId}:${userId}`;
		this.pendingImages.set(key, {
			guildId,
			userId,
			channelId,
			kind,
			recordId,
			requestedAt: Date.now()
		});
	}

	#extractImageAttachment(message) {
		const attachments = message?.attachments ? [...message.attachments.values()] : [];
		for (const attachment of attachments) {
			if (attachment?.contentType?.startsWith?.('image/')) return attachment;
			if (attachment?.url && /\.(png|jpe?g|gif|webp)$/i.test(attachment.url)) return attachment;
		}
		return null;
	}

	#mergePreviewContent(prefix, content) {
		const base = content ? `${prefix}\n\n${content}` : prefix;
		return base.length > 2000 ? `${base.slice(0, 1997)}...` : base;
	}

	#isStaff(interaction) {
		const ownerId = this.client?.context?.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID;
		if (ownerId && String(interaction.user.id) === String(ownerId)) return true;

		const modRoleId = this.client?.context?.config?.modRoleId || process.env.MOD_ROLE_ID;
		if (modRoleId && interaction.member?.roles?.cache?.has?.(modRoleId)) return true;

		if (interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator)) return true;

		return false;
	}

	async #reply(interaction, payload) {
		if (!interaction) return;
		if (!interaction.deferred && !interaction.replied) {
			await interaction.reply(payload);
		} else {
			await interaction.followUp(payload);
		}
	}

	async #followUp(interaction, payload) {
		if (!interaction) return;
		if (!interaction.deferred && !interaction.replied) {
			await interaction.reply(payload);
		} else {
			await interaction.followUp(payload);
		}
	}

	async #columnExists(table, column) {
		const [rows] = await this.db.query(
			`SELECT COUNT(*) AS n
                         FROM information_schema.COLUMNS
                         WHERE TABLE_SCHEMA = DATABASE()
                           AND TABLE_NAME = ?
                           AND COLUMN_NAME = ?`,
			[table, column]
		);
		return Number(rows?.[0]?.n || 0) > 0;
	}

	async #ensureSchema() {
		if (this.#schemaReady) return;
		await this.db.query(`CREATE TABLE IF NOT EXISTS staff_announcements (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        guild_id VARCHAR(32) NOT NULL,
                        author_id VARCHAR(32) NOT NULL,
                        content TEXT NULL,
                        embed_title VARCHAR(256) NULL,
                        embed_description TEXT NULL,
                        embed_color VARCHAR(7) NULL,
                        embed_image VARCHAR(500) NULL,
                        scheduled_at DATETIME NULL,
                        status ENUM('draft','scheduled','sent','failed') NOT NULL DEFAULT 'draft',
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        sent_at DATETIME NULL,
                        INDEX ix_guild (guild_id),
                        INDEX ix_status (status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);


		if (!(await this.#columnExists('settings', 'events_admin_message_id'))) {
			await this.db
				.query('ALTER TABLE settings ADD COLUMN events_admin_message_id VARCHAR(32) NULL')
				.catch(() => {});
		}

		if (!(await this.#columnExists('events', 'guild_id'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN guild_id VARCHAR(32) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'description'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN description TEXT NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'created_by'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN created_by VARCHAR(32) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'scheduled_at'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN scheduled_at DATETIME NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'message_content'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN message_content TEXT NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'embed_title'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN embed_title VARCHAR(256) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'embed_color'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN embed_color VARCHAR(7) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'embed_image'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN embed_image VARCHAR(500) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'game'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN game VARCHAR(120) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'min_participants'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN min_participants INT NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'max_participants'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN max_participants INT NULL').catch(() => {});
		}
		if (!(await this.#columnExists('events', 'temp_group_id'))) {
			await this.db.query('ALTER TABLE events ADD COLUMN temp_group_id BIGINT UNSIGNED NULL').catch(() => {});
		}

		await this.db
			.query("ALTER TABLE events MODIFY COLUMN status ENUM('draft','scheduled','running','ended') NOT NULL DEFAULT 'draft'")
			.catch(() => {});

		if (!(await this.#columnExists('temp_groups', 'guild_id'))) {
			await this.db.query('ALTER TABLE temp_groups ADD COLUMN guild_id VARCHAR(32) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('temp_groups', 'text_channel_id'))) {
			await this.db.query('ALTER TABLE temp_groups ADD COLUMN text_channel_id VARCHAR(32) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('temp_groups', 'voice_channel_id'))) {
			await this.db.query('ALTER TABLE temp_groups ADD COLUMN voice_channel_id VARCHAR(32) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('temp_groups', 'panel_channel_id'))) {
			await this.db.query('ALTER TABLE temp_groups ADD COLUMN panel_channel_id VARCHAR(32) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('temp_groups', 'panel_message_id'))) {
			await this.db.query('ALTER TABLE temp_groups ADD COLUMN panel_message_id VARCHAR(32) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('temp_groups', 'created_by'))) {
			await this.db.query('ALTER TABLE temp_groups ADD COLUMN created_by VARCHAR(32) NULL').catch(() => {});
		}
		if (!(await this.#columnExists('temp_groups', 'event_id'))) {
			await this.db.query('ALTER TABLE temp_groups ADD COLUMN event_id BIGINT UNSIGNED NULL').catch(() => {});
		}

		await this.services?.event?.ensureSchema?.().catch(() => {});
		await this.services?.tempGroup?.ensureSchema?.().catch(() => {});

		await this.db.query(`CREATE TABLE IF NOT EXISTS event_messages (
                        event_id BIGINT UNSIGNED NOT NULL,
                        channel_id VARCHAR(32) NOT NULL,
                        message_id VARCHAR(32) NOT NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        PRIMARY KEY(event_id, channel_id),
                        UNIQUE KEY uniq_message (message_id),
                        INDEX ix_event (event_id),
                        FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`).catch(() => {});

		this.#schemaReady = true;
	}
}

module.exports = { StaffPanelService };
