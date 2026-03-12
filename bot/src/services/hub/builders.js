'use strict';

const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
} = require('discord.js');
const { normalizeColor, formatParticipants } = require('../../utils/serviceHelpers');

const DEFAULT_COLOR = 0x5865f2;

// ===== Builder/formatter/utility methods — mixed into HubService.prototype =====

async function _upsertPreviewMessage(request) {
	if (!request) return;
	const channelId = request.preview_channel_id;
	const messageId = request.preview_message_id;
	const channel = channelId
		? await this.client.channels.fetch(channelId).catch(() => null)
		: await this._fetchChannelFromRequest(request);

	if (!channel?.isTextBased?.()) return;
	const payload = this._buildRequestPreview(request);
	let message = null;
	if (messageId) {
		message = await channel.messages.fetch(messageId).catch(() => null);
		if (message) {
			await message.edit(payload).catch((err) => {
				if (err?.code === 10008) return; // Unknown message
				this.logger?.warn({ err, messageId, channelId: channel?.id, requestId: request?.id }, 'Failed to edit hub preview message');
			});
		}
	}
	if (!message) {
		message = await channel.send(payload).catch(() => null);
	}
	if (message) {
		await this._updateRequest(request.id, {
			preview_channel_id: message.channelId,
			preview_message_id: message.id
		});
	}
}

function _buildRequestPreview(request) {
	const payload = request.kind === 'announcement'
		? this._buildAnnouncementPayload(request)
		: this._buildEventPayload(request);

	let prefix = '**✨ Aperçu de ta demande**\n';
	if (request.scheduled_at) {
		prefix += `📅 **Publication programmée pour:** ${this._formatSchedule(request.scheduled_at)}\n`;
	} else {
		prefix += '⚡ **Publication:** Envoi immédiat après validation\n';
	}

	if (request.status === 'draft') {
		prefix += '\n> 💡 *Tu peux encore modifier ta demande avant de l\'envoyer !*';
	}

	const content = this._mergePreviewContent(prefix, payload.content);
	const components = request.status === 'draft' ? this._buildRequestActions(request) : [];

	return {
		content,
		embeds: payload.embeds,
		components,
		allowedMentions: { parse: [] }
	};
}

function _buildRequestActions(request) {
	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`hub:req:edit:${request.id}`)
			.setLabel('✏️ Modifier')
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(`hub:req:schedule:${request.id}`)
			.setLabel('⏰ Programmer')
			.setStyle(ButtonStyle.Secondary),
		new ButtonBuilder()
			.setCustomId(`hub:req:submit:${request.id}`)
			.setLabel('📤 Envoyer à la modération')
			.setStyle(ButtonStyle.Success)
	);
	return [row];
}

function _buildReviewPayload(request) {
	const isAnnouncement = request.kind === 'announcement';
	const meta = new EmbedBuilder()
		.setTitle(isAnnouncement ? '📢 Nouvelle demande d\'annonce' : '🎮 Nouvelle demande d\'événement')
		.setColor(DEFAULT_COLOR)
		.setDescription(
			isAnnouncement
				? '**Un membre souhaite publier une annonce à toutes les zones**'
				: '**Un membre souhaite organiser un événement avec zone temporaire**'
		)
		.addFields(
			{
				name: '👤 Demandeur',
				value: `<@${request.user_id}>\n\`ID: ${request.user_id}\``,
				inline: true
			},
			{
				name: '⏰ Publication prévue',
				value: request.scheduled_at
					? `📅 ${this._formatSchedule(request.scheduled_at)}`
					: '⚡ **Envoi immédiat**',
				inline: true
			},
			{
				name: '📋 Type',
				value: isAnnouncement ? '📣 Annonce' : '🎮 Événement',
				inline: true
			}
		)
		.setTimestamp(new Date(request.created_at || Date.now()));

	if (isAnnouncement && request.content) {
		meta.addFields({
			name: '🏷️ Tags',
			value: `\`${String(request.content).slice(0, 1024)}\``,
			inline: false
		});
	}

	if (!isAnnouncement) {
		const details = [];
		if (request.game) {
			details.push(`🎯 **Jeu:** ${String(request.game).slice(0, 100)}`);
		}
		if (request.min_participants || request.max_participants) {
			const min = request.min_participants || '?';
			const max = request.max_participants || '?';
			details.push(`👥 **Participants:** ${min} - ${max}`);
		}
		if (request.message_content) {
			details.push(`🏷️ **Tags:** \`${String(request.message_content).slice(0, 100)}\``);
		}
		if (details.length > 0) {
			meta.addFields({
				name: '📊 Détails de l\'événement',
				value: details.join('\n'),
				inline: false
			});
		}
	}

	const preview = isAnnouncement
		? this._buildAnnouncementPayload(request)
		: this._buildEventPayload(request);

	const components = [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`hub:req:deny:${request.id}`)
				.setLabel('❌ Refuser')
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId(`hub:req:editaccept:${request.id}`)
				.setLabel('✏️ Modifier & Accepter')
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`hub:req:accept:${request.id}`)
				.setLabel('✅ Accepter')
				.setStyle(ButtonStyle.Success)
		)
	];

	return {
		embeds: [meta, ...preview.embeds],
		components,
		allowedMentions: { parse: [] }
	};
}

async function _disableReviewMessage(request, statusLabel) {
	if (!request?.review_channel_id || !request?.review_message_id) return;
	try {
		const channel = await this.client.channels.fetch(request.review_channel_id).catch(() => null);
		if (!channel?.messages?.fetch) return;
		const message = await channel.messages.fetch(request.review_message_id).catch(() => null);
		if (!message) return;

		const components = this._disableMessageComponents(message);
		const payload = this._buildReviewPayload(request);
		if (statusLabel) {
			payload.embeds[0].setFooter({ text: statusLabel });
		}

		await message.edit({ embeds: payload.embeds, components }).catch((err) => {
			if (err?.code === 10008) return; // Unknown message
			this.logger?.warn({ err, requestId: request?.id, messageId: message?.id }, 'Failed to disable hub review message');
		});
	} catch (err) {
		this.logger?.warn({ err, requestId: request?.id }, 'Failed to update hub review message');
	}
}

async function _disablePreviewMessage(request, statusLabel) {
	if (!request?.preview_channel_id || !request?.preview_message_id) return;
	try {
		const channel = await this.client.channels.fetch(request.preview_channel_id).catch(() => null);
		if (!channel?.messages?.fetch) return;
		const message = await channel.messages.fetch(request.preview_message_id).catch(() => null);
		if (!message) return;

		const payload = this._buildRequestPreview({ ...request, status: 'locked' });
		if (statusLabel) {
			payload.content = `${payload.content}\n\nStatut: ${statusLabel}`;
		}
		await message.edit({ content: payload.content, embeds: payload.embeds, components: [] }).catch((err) => {
			if (err?.code === 10008) return; // Unknown message
			this.logger?.warn({ err, requestId: request?.id, messageId: message?.id }, 'Failed to disable hub preview message');
		});
	} catch (err) {
		this.logger?.warn({ err, requestId: request?.id }, 'Failed to update hub preview message');
	}
}

function _disableMessageComponents(message) {
	const components = [];
	for (const row of message.components || []) {
		const newRow = new ActionRowBuilder();
		for (const component of row.components || []) {
			try {
				const cloned = ButtonBuilder.from(component);
				cloned.setDisabled(true);
				newRow.addComponents(cloned);
			} catch { /* ignored */ }
		}
		if (newRow.components.length) components.push(newRow);
	}
	return components;
}

function _buildAnnouncementModal(existing = null, options = {}) {
	const modalId = options.customId || `hub:announce:modal${existing?.id ? `:${existing.id}` : ''}`;
	const modalTitle = options.title || '📣 Créer une annonce';
	const modal = new ModalBuilder().setCustomId(modalId).setTitle(modalTitle);

	const titleInput = new TextInputBuilder()
		.setCustomId('announceTitle')
		.setLabel('📝 Titre de l\'annonce *')
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(256)
		.setPlaceholder('Ex: Nouveau système de récompenses !')
		.setValue(existing?.embed_title || '');

	const contentInput = new TextInputBuilder()
		.setCustomId('announceContent')
		.setLabel('✍️ Contenu du message *')
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(true)
		.setMaxLength(4000)
		.setPlaceholder('Décris ton annonce en détail...')
		.setValue(existing?.embed_description || '');

	const colorInput = new TextInputBuilder()
		.setCustomId('announceColor')
		.setLabel('🎨 Couleur de l\'embed (optionnel)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(16)
		.setPlaceholder('#5865F2 (bleu Discord) ou #FF5733 (orange)')
		.setValue(existing?.embed_color || '');

	const tagInput = new TextInputBuilder()
		.setCustomId('announceTag')
		.setLabel('🏷️ Tags (séparés par virgules, max 5)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(128)
		.setPlaceholder('Ex: Nouveautés, Important, Communauté')
		.setValue(existing?.content || '');

	const imageInput = new TextInputBuilder()
		.setCustomId('announceImage')
		.setLabel('🖼️ Image (tape "oui" pour ajouter une image)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(120)
		.setPlaceholder('oui (tu pourras l\'envoyer après validation)');

	modal.addComponents(
		new ActionRowBuilder().addComponents(titleInput),
		new ActionRowBuilder().addComponents(contentInput),
		new ActionRowBuilder().addComponents(colorInput),
		new ActionRowBuilder().addComponents(tagInput),
		new ActionRowBuilder().addComponents(imageInput)
	);

	return modal;
}

function _buildEventModal(existing = null, options = {}) {
	const modalId = options.customId || `hub:event:modal${existing?.id ? `:${existing.id}` : ''}`;
	const modalTitle = options.title || '🎮 Créer un événement';
	const modal = new ModalBuilder().setCustomId(modalId).setTitle(modalTitle);

	const nameInput = new TextInputBuilder()
		.setCustomId('eventName')
		.setLabel('🎯 Nom de l\'événement *')
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(120)
		.setPlaceholder('Ex: Soirée Minecraft - Construction collaborative')
		.setValue(existing?.embed_title || '');

	const contentInput = new TextInputBuilder()
		.setCustomId('eventContent')
		.setLabel('📋 Description de l\'événement *')
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(true)
		.setMaxLength(4000)
		.setPlaceholder('Décris ton événement, les règles, le déroulement...')
		.setValue(existing?.embed_description || '');

	const colorInput = new TextInputBuilder()
		.setCustomId('eventColor')
		.setLabel('🎨 Couleur de l\'embed (optionnel)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(16)
		.setPlaceholder('#5865F2 (bleu) ou #9B59B6 (violet)')
		.setValue(existing?.embed_color || '');

	const participantsInput = new TextInputBuilder()
		.setCustomId('eventParticipants')
		.setLabel('👥 Nombre de participants (optionnel)')
		.setStyle(TextInputStyle.Short)
		.setRequired(false)
		.setMaxLength(64)
		.setPlaceholder('min=4 max=10 (ou juste max=10)')
		.setValue(formatParticipants(existing));

	const optionsInput = new TextInputBuilder()
		.setCustomId('eventOptions')
		.setLabel('⚙️ Options : Tag / Jeu / Image (optionnel)')
		.setStyle(TextInputStyle.Paragraph)
		.setRequired(false)
		.setMaxLength(600)
		.setPlaceholder('tag=PvP, Compétitif\njeu=Valorant\nimage=oui')
		.setValue(this._formatEventOptions(existing));

	modal.addComponents(
		new ActionRowBuilder().addComponents(nameInput),
		new ActionRowBuilder().addComponents(contentInput),
		new ActionRowBuilder().addComponents(colorInput),
		new ActionRowBuilder().addComponents(participantsInput),
		new ActionRowBuilder().addComponents(optionsInput)
	);

	return modal;
}

function _buildScheduleModal(request) {
	const isAnnouncement = request.kind === 'announcement';
	const modal = new ModalBuilder()
		.setCustomId(`hub:req:schedule:modal:${request.id}`)
		.setTitle(isAnnouncement ? '⏰ Programmer l\'annonce' : '⏰ Programmer l\'événement');

	const dateInput = new TextInputBuilder()
		.setCustomId('scheduleDate')
		.setLabel('📅 Date de publication *')
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(10)
		.setPlaceholder('Ex: 15-02-2026 (JJ-MM-AAAA)');

	const timeInput = new TextInputBuilder()
		.setCustomId('scheduleTime')
		.setLabel('🕐 Heure de publication (Paris) *')
		.setStyle(TextInputStyle.Short)
		.setRequired(true)
		.setMaxLength(5)
		.setPlaceholder('Ex: 18:30 (HH:MM format 24h)');

	if (request?.scheduled_at) {
		const parts = this._formatParisScheduleParts(request.scheduled_at);
		if (parts?.date) dateInput.setValue(parts.date);
		if (parts?.time) timeInput.setValue(parts.time);
	}

	modal.addComponents(
		new ActionRowBuilder().addComponents(dateInput),
		new ActionRowBuilder().addComponents(timeInput)
	);

	return modal;
}

function _buildEditAcceptModal(request) {
	if (request.kind === 'announcement') {
		return this._buildAnnouncementModal(request, {
			customId: `hub:req:editaccept:modal:${request.id}`,
			title: 'Modifier et accepter'
		});
	}
	return this._buildEventModal(request, {
		customId: `hub:req:editaccept:modal:${request.id}`,
		title: 'Modifier et accepter'
	});
}

function _buildAnnouncementPayload(request) {
	const embeds = [];
	const embed = new EmbedBuilder();

	const contentParts = [];
	if (request.content) contentParts.push(request.content);

	if (request.embed_title) {
		embed.setTitle(request.embed_title.slice(0, 256));
	}
	if (request.embed_description) {
		embed.setDescription(request.embed_description.slice(0, 4096));
	}

	const color = this._resolveColor(request.embed_color) || DEFAULT_COLOR;
	embed.setColor(color);

	if (request.embed_image) {
		embed.setImage(request.embed_image);
	}

	embeds.push(embed);
	const content = contentParts.length ? contentParts.join('\n') : null;
	return { content, embeds };
}

function _buildEventPayload(request) {
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
		const tags = String(request.message_content).slice(0, 200);
		embed.setFooter({ text: `🏷️ ${tags}` });
	}

	if (request.game) {
		embed.addFields({ name: 'Jeu', value: String(request.game).slice(0, 256), inline: false });
	}

	if (request.embed_image) {
		embed.setImage(request.embed_image);
	}

	const color = this._resolveColor(request.embed_color) || DEFAULT_COLOR;
	embed.setColor(color);
	embeds.push(embed);

	return { embeds, content: null };
}

function _formatEventOptions(existing) {
	if (!existing) return '';
	const lines = [];
	if (existing.message_content) {
		lines.push(`tag=${String(existing.message_content).replace(/\s+/g, ' ').slice(0, 128)}`);
	}
	if (existing.game) lines.push(`jeu=${String(existing.game).slice(0, 120)}`);
	if (existing.embed_image) lines.push(`image=${String(existing.embed_image).slice(0, 500)}`);
	return lines.join('\n');
}

function _parseOptions(raw) {
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

function _resolveColor(value) {
	if (!value) return null;
	const normalized = normalizeColor(value);
	if (!normalized) return null;
	return parseInt(normalized.slice(1), 16);
}

function _normalizeUrl(value) {
	if (!value) return null;
	const trimmed = String(value).trim();
	if (!trimmed) return null;
	if (!/^https?:\/\//i.test(trimmed)) return null;
	return trimmed.slice(0, 500);
}

function _isAffirmative(value) {
	const trimmed = String(value || '').trim().toLowerCase();
	return ['oui', 'yes', 'y', 'true', '1'].includes(trimmed);
}

function _validateTags(rawTags) {
	if (!rawTags || typeof rawTags !== 'string') return '';
	const tags = rawTags
		.split(',')
		.map((t) => t.trim())
		.filter((t) => t.length > 0 && t.length <= 50)
		.slice(0, 5);
	return tags.join(', ');
}

function _formatSchedule(value) {
	const dt = new Date(value);
	if (Number.isNaN(dt.getTime())) return 'date invalide';
	return dt.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

function _formatParisScheduleParts(value) {
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

function _parseParisSchedule(dateRaw, timeRaw) {
	const dateMatch = String(dateRaw || '').trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
	const timeMatch = String(timeRaw || '').trim().match(/^(\d{2}):(\d{2})$/);
	if (!dateMatch || !timeMatch) return null;

	const day = Number(dateMatch[1]);
	const month = Number(dateMatch[2]);
	const year = Number(dateMatch[3]);
	const hour = Number(timeMatch[1]);
	const minute = Number(timeMatch[2]);

	if (!this._isValidDateParts(year, month, day, hour, minute)) return null;

	const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
	if (Number.isNaN(utcGuess.getTime())) return null;
	const offsetMinutes = this._getTimeZoneOffsetMinutes(utcGuess, 'Europe/Paris');
	const candidate = new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000);
	const parts = this._formatParisScheduleParts(candidate);
	const expectedDate = `${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}-${year}`;
	const expectedTime = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
	if (!parts || parts.date !== expectedDate || parts.time !== expectedTime) return null;
	return candidate;
}

function _getTimeZoneOffsetMinutes(date, timeZone) {
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

function _isValidDateParts(year, month, day, hour, minute) {
	if (!Number.isInteger(year) || year < 2000 || year > 2100) return false;
	if (!Number.isInteger(month) || month < 1 || month > 12) return false;
	if (!Number.isInteger(day) || day < 1 || day > 31) return false;
	if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false;
	if (!Number.isInteger(minute) || minute < 0 || minute > 59) return false;
	return true;
}

function _mergePreviewContent(prefix, content) {
	const base = content ? `${prefix}\n\n${content}` : prefix;
	return base.length > 2000 ? `${base.slice(0, 1997)}...` : base;
}

module.exports = {
	_upsertPreviewMessage,
	_buildRequestPreview,
	_buildRequestActions,
	_buildReviewPayload,
	_disableReviewMessage,
	_disablePreviewMessage,
	_disableMessageComponents,
	_buildAnnouncementModal,
	_buildEventModal,
	_buildScheduleModal,
	_buildEditAcceptModal,
	_buildAnnouncementPayload,
	_buildEventPayload,
	_formatEventOptions,
	_parseOptions,
	_resolveColor,
	_normalizeUrl,
	_isAffirmative,
	_validateTags,
	_formatSchedule,
	_formatParisScheduleParts,
	_parseParisSchedule,
	_getTimeZoneOffsetMinutes,
	_isValidDateParts,
	_mergePreviewContent,
};
