'use strict';

const { MessageFlags } = require('discord.js');
const { normalizeColor, parseParticipants } = require('../../utils/serviceHelpers');

// ===== Request lifecycle handlers — mixed into HubService.prototype =====

async function _handleAnnouncementModal(interaction) {
	try {
		const customId = interaction.customId;
		const existingId = Number(customId.split(':').at(-1));

		const existing = existingId ? await this._getRequest(existingId) : null;
		if (existing && existing.user_id !== interaction.user.id) {
			await this._reply(interaction, {
				content: '🚫 **Action non autorisée**\n\nTu ne peux modifier que tes propres demandes.',
				flags: MessageFlags.Ephemeral
			});
			return;
		}

		const embedTitle = interaction.fields.getTextInputValue('announceTitle')?.trim() || null;
		const embedDescription = interaction.fields.getTextInputValue('announceContent')?.trim() || null;
		const colorRaw = interaction.fields.getTextInputValue('announceColor')?.trim() || '';
		const tagRaw = interaction.fields.getTextInputValue('announceTag')?.trim() || '';
		const tagValue = this._validateTags(tagRaw);
		const imageRaw = interaction.fields.getTextInputValue('announceImage')?.trim() || '';

		const embedColor = colorRaw ? normalizeColor(colorRaw) : null;
		if (colorRaw && !embedColor) {
			await this._reply(interaction, {
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

		const imageUrl = this._normalizeUrl(imageRaw);
		const wantsImage = this._isAffirmative(imageRaw);
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
			await this._updateRequest(existing.id, payload);
			request = await this._getRequest(existing.id);
		} else {
			const id = await this._insertRequest(payload);
			request = await this._getRequest(id);
		}

		if (pendingImage) {
			this._setPendingImage({
				guildId: interaction.guildId,
				userId: interaction.user.id,
				channelId: interaction.channelId,
				recordId: request.id
			});
			await this._reply(interaction, {
				content: '📸 **Image requise !**\n\n' +
					'Envoie ton image dans ce salon maintenant.\n' +
					'Formats acceptés : PNG, JPG, GIF, WEBP\n\n' +
					'> ⏱️ *Tu as 10 minutes pour l\'envoyer.*',
				flags: MessageFlags.Ephemeral
			});
			return;
		}

		await this._upsertPreviewMessage(request);
		await this._reply(interaction, {
			content: '✅ **Aperçu mis à jour !**\n\n' +
				'Ton aperçu est maintenant visible dans ce salon.\n' +
				'Vérifie que tout est correct avant d\'envoyer ta demande.',
			flags: MessageFlags.Ephemeral
		});
	} catch (err) {
		this.logger?.warn({ err }, 'Failed to handle hub announcement modal');
		await this._reply(interaction, {
			content: '❌ **Erreur**\n\n' +
				'Impossible de préparer ton annonce pour le moment.\n' +
				'Réessaye dans quelques instants.',
			flags: MessageFlags.Ephemeral
		});
	}
}

async function _handleEventModal(interaction) {
	try {
		const customId = interaction.customId;
		const existingId = Number(customId.split(':').at(-1));

		const existing = existingId ? await this._getRequest(existingId) : null;
		if (existing && existing.user_id !== interaction.user.id) {
			await this._reply(interaction, {
				content: '🚫 **Action non autorisée**\n\nTu ne peux modifier que tes propres demandes.',
				flags: MessageFlags.Ephemeral
			});
			return;
		}

		const name = interaction.fields.getTextInputValue('eventName')?.trim() || '';
		const description = interaction.fields.getTextInputValue('eventContent')?.trim() || null;
		const colorRaw = interaction.fields.getTextInputValue('eventColor')?.trim() || '';
		const participantsRaw = interaction.fields.getTextInputValue('eventParticipants')?.trim() || '';
		const optionsRaw = interaction.fields.getTextInputValue('eventOptions') || '';

		if (!name) {
			await this._reply(interaction, {
				content: '❌ **Titre manquant**\n\nLe titre de l\'événement est **obligatoire**.\nMerci de remplir ce champ.',
				flags: MessageFlags.Ephemeral
			});
			return;
		}

		const options = this._parseOptions(optionsRaw);
		const tagRaw = options.tag || options.type || '';
		const tagValue = this._validateTags(String(tagRaw || ''));
		const gameRaw = options.jeu || options['jeu.x'] || options.game || options.jeux || '';
		const game = gameRaw ? String(gameRaw).trim().slice(0, 120) : null;
		const imageRaw = options.image || options.img || '';

		const embedColor = colorRaw ? normalizeColor(colorRaw) : null;
		if (colorRaw && !embedColor) {
			await this._reply(interaction, {
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

		const imageUrl = this._normalizeUrl(imageRaw);
		const wantsImage = this._isAffirmative(imageRaw);
		let embedImage = existing?.embed_image || null;
		let pendingImage = false;
		if (imageUrl) {
			embedImage = imageUrl;
		} else if (wantsImage) {
			embedImage = null;
			pendingImage = true;
		}

		const participantLimits = parseParticipants(participantsRaw);

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
			await this._updateRequest(existing.id, payload);
			request = await this._getRequest(existing.id);
		} else {
			const id = await this._insertRequest(payload);
			request = await this._getRequest(id);
		}

		if (pendingImage) {
			this._setPendingImage({
				guildId: interaction.guildId,
				userId: interaction.user.id,
				channelId: interaction.channelId,
				recordId: request.id
			});
			await this._reply(interaction, {
				content: '📸 **Image requise !**\n\n' +
					'Envoie ton image dans ce salon maintenant.\n' +
					'Formats acceptés : PNG, JPG, GIF, WEBP\n\n' +
					'> ⏱️ *Tu as 10 minutes pour l\'envoyer.*',
				flags: MessageFlags.Ephemeral
			});
			return;
		}

		await this._upsertPreviewMessage(request);
		await this._reply(interaction, {
			content: '✅ **Aperçu mis à jour !**\n\n' +
				'Ton aperçu est maintenant visible dans ce salon.\n' +
				'Vérifie que tout est correct avant d\'envoyer ta demande.',
			flags: MessageFlags.Ephemeral
		});
	} catch (err) {
		this.logger?.warn({ err }, 'Failed to handle hub event modal');
		await this._reply(interaction, {
			content: '❌ **Erreur**\n\n' +
				'Impossible de préparer ton événement pour le moment.\n' +
				'Réessaye dans quelques instants.',
			flags: MessageFlags.Ephemeral
		});
	}
}

async function _handleScheduleModal(interaction, request) {
	const dateRaw = interaction.fields.getTextInputValue('scheduleDate')?.trim() || '';
	const timeRaw = interaction.fields.getTextInputValue('scheduleTime')?.trim() || '';
	const scheduledAt = this._parseParisSchedule(dateRaw, timeRaw);
	if (!scheduledAt) {
		await this._reply(interaction, {
			content: '❌ **Date ou heure invalide**\n\n' +
				'**Format attendu :**\n' +
				'• Date : `JJ-MM-AAAA` (ex: 15-02-2026)\n' +
				'• Heure : `HH:MM` (ex: 18:30)\n\n' +
				'> 🕐 *L\'heure doit être au fuseau horaire de Paris*',
			flags: MessageFlags.Ephemeral
		});
		return;
	}

	await this._updateRequest(request.id, { scheduled_at: scheduledAt });
	const updated = await this._getRequest(request.id);
	await this._upsertPreviewMessage(updated);
	await this._reply(interaction, {
		content: `⏰ **Publication programmée !**\n\n` +
			`📅 Date prévue : **${this._formatSchedule(scheduledAt)}** (heure de Paris)\n\n` +
			`Ton aperçu a été mis à jour. Tu peux maintenant envoyer ta demande à la modération.`,
		flags: MessageFlags.Ephemeral
	});
}

async function _handleEditAcceptModal(interaction, request) {
	try {
		if (request.kind === 'announcement') {
			const embedTitle = interaction.fields.getTextInputValue('announceTitle')?.trim() || null;
			const embedDescription = interaction.fields.getTextInputValue('announceContent')?.trim() || null;
			const colorRaw = interaction.fields.getTextInputValue('announceColor')?.trim() || '';
			const tagRaw = interaction.fields.getTextInputValue('announceTag')?.trim() || '';
			const tagValue = this._validateTags(tagRaw);
			const imageRaw = interaction.fields.getTextInputValue('announceImage')?.trim() || '';

			const embedColor = colorRaw ? normalizeColor(colorRaw) : null;
			if (colorRaw && !embedColor) {
				await this._reply(interaction, { content: 'Couleur invalide.', flags: MessageFlags.Ephemeral });
				return;
			}

			let embedImage = request.embed_image || null;
			if (imageRaw) {
				const imageUrl = this._normalizeUrl(imageRaw);
				if (!imageUrl) {
					await this._reply(interaction, { content: 'Image invalide (URL attendue).', flags: MessageFlags.Ephemeral });
					return;
				}
				embedImage = imageUrl;
			}

			await this._updateRequest(request.id, {
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
				await this._reply(interaction, { content: 'Le titre est obligatoire.', flags: MessageFlags.Ephemeral });
				return;
			}

			const options = this._parseOptions(optionsRaw);
			const tagRaw = options.tag || options.type || '';
			const tagValue = this._validateTags(String(tagRaw || ''));
			const gameRaw = options.jeu || options['jeu.x'] || options.game || options.jeux || '';
			const game = gameRaw ? String(gameRaw).trim().slice(0, 120) : null;
			const imageRaw = options.image || options.img || '';

			const embedColor = colorRaw ? normalizeColor(colorRaw) : null;
			if (colorRaw && !embedColor) {
				await this._reply(interaction, { content: 'Couleur invalide.', flags: MessageFlags.Ephemeral });
				return;
			}

			let embedImage = request.embed_image || null;
			if (imageRaw) {
				const imageUrl = this._normalizeUrl(imageRaw);
				if (!imageUrl) {
					await this._reply(interaction, { content: 'Image invalide (URL attendue).', flags: MessageFlags.Ephemeral });
					return;
				}
				embedImage = imageUrl;
			}

			const participantLimits = parseParticipants(participantsRaw);

			await this._updateRequest(request.id, {
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

		const updated = await this._getRequest(request.id);
		const result = await this._acceptRequest(updated, interaction.user.id);
		if (!result.ok) {
			await this._reply(interaction, { content: result.message || 'Impossible d\'accepter.', flags: MessageFlags.Ephemeral });
			return;
		}

		await this._reply(interaction, { content: 'Demande acceptée.', flags: MessageFlags.Ephemeral });
	} catch (err) {
		this.logger?.warn({ err, requestId: request.id }, 'Failed to edit/accept hub request');
		await this._reply(interaction, { content: 'Impossible de traiter la demande.', flags: MessageFlags.Ephemeral });
	}
}

async function _acceptRequest(request, actorId) {
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

		await this._updateRequest(request.id, {
			status: 'accepted',
			decided_by: actorId,
			decided_at: new Date()
		});
		const updated = await this._getRequest(request.id);
		await this._disableReviewMessage(updated, '✅ Acceptée');
		await this._disablePreviewMessage(updated, '✅ Acceptée et publiée');
		await this._notifyUser(request.user_id, {
			content: request.kind === 'announcement'
				? '🎉 **Félicitations !** Ton annonce a été acceptée et publiée à toutes les zones !'
				: '🎉 **Félicitations !** Ton événement a été accepté et la zone temporaire sera créée prochainement !'
		});
		return { ok: true };
	} catch (err) {
		this.logger?.warn({ err, requestId: request.id }, 'Failed to accept hub request');
		return { ok: false, message: 'Impossible d\'envoyer la demande.' };
	}
}

async function _denyRequest(request, actorId) {
	await this._updateRequest(request.id, {
		status: 'denied',
		decided_by: actorId,
		decided_at: new Date()
	});
	const updated = await this._getRequest(request.id);
	await this._disableReviewMessage(updated, '❌ Refusée');
	await this._disablePreviewMessage(updated, '❌ Refusée par la modération');
	await this._notifyUser(request.user_id, {
		content: request.kind === 'announcement'
			? '❌ **Demande refusée** - Ton annonce n\'a pas été acceptée par la modération. Tu peux en créer une nouvelle si nécessaire.'
			: '❌ **Demande refusée** - Ton événement n\'a pas été accepté par la modération. Tu peux en créer un nouveau si nécessaire.'
	});
}

async function _deliverRequest(request) {
	if (!request) return false;
	const payload = this._buildReviewPayload(request);
	const ownerId = this._getOwnerId();
	const channelId = await this._getRequestsChannelId(request.guild_id);

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
		await this._updateRequest(request.id, {
			review_channel_id: message.channelId,
			review_message_id: message.id
		});
		return true;
	}

	return false;
}

module.exports = {
	_handleAnnouncementModal,
	_handleEventModal,
	_handleScheduleModal,
	_handleEditAcceptModal,
	_acceptRequest,
	_denyRequest,
	_deliverRequest,
};
