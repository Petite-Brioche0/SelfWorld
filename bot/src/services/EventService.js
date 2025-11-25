const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { makeId } = require('../utils/ids');

class EventService {
	constructor(client, db, logger = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
	}

	buildAnnouncementEmbed(payload) {
		const embed = new EmbedBuilder();
		if (payload?.title) embed.setTitle(payload.title);
		if (payload?.description) embed.setDescription(payload.description);
		if (payload?.color) embed.setColor(payload.color);
		if (payload?.imageUrl) embed.setImage(payload.imageUrl);
		if (payload?.thumbnailUrl) embed.setThumbnail(payload.thumbnailUrl);
		if (payload?.footer) embed.setFooter({ text: payload.footer });
		if (payload?.timestamp) embed.setTimestamp(new Date(payload.timestamp));
		return embed;
	}

	buildEventEmbed(eventRow, { participantsCount = 0, spectatorsCount = 0, isFull = false } = {}) {
		const embed = new EmbedBuilder()
			.setTitle(eventRow?.name || 'Événement')
			.setDescription(eventRow?.description || '');
		if (eventRow?.game) {
			embed.addFields({ name: 'Jeu', value: eventRow.game, inline: true });
		}
		if (eventRow?.starts_at) {
			embed.addFields({ name: 'Début', value: new Date(eventRow.starts_at).toISOString(), inline: true });
		}
		if (eventRow?.ends_at) {
			embed.addFields({ name: 'Fin', value: new Date(eventRow.ends_at).toISOString(), inline: true });
		}
		embed.addFields(
			{ name: 'Participants', value: String(participantsCount), inline: true },
			{ name: 'Observateurs', value: String(spectatorsCount), inline: true }
		);
		if (eventRow?.max_participants) {
			embed.addFields({ name: 'Places max', value: String(eventRow.max_participants), inline: true });
		}
		if (isFull) {
			embed.addFields({ name: 'Statut', value: 'Complet', inline: true });
		}
		return embed;
	}

	serializePayload(payload, { authorId, guildId }) {
		const data = { ...payload, authorId, guildId };
		return JSON.stringify(data);
	}

	async saveAnnouncementDraft(payload, { authorId, guildId, scheduledAt = null }) {
		const serialized = this.serializePayload(payload, { authorId, guildId });
		const [res] = await this.db.query(
			'INSERT INTO events (name, status, author_id, scheduled_at, announce_payload) VALUES (?, ?, ?, ?, ?)',
			[payload?.title || 'Annonce', 'draft', authorId || null, scheduledAt, serialized]
		);
		return res.insertId;
	}

	async saveEventDraft(form, { authorId, guildId, scheduledAt = null, createTempGroup = false }) {
		const serialized = this.serializePayload({ ...form, createTempGroup }, { authorId, guildId });
		const [res] = await this.db.query(
			'INSERT INTO events (name, status, author_id, description, game, max_participants, temp_group_id, starts_at, ends_at, scheduled_at, announce_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[
				form?.name || 'Événement',
				'draft',
				authorId || null,
				form?.description || null,
				form?.game || null,
				form?.maxParticipants || null,
				form?.tempGroupId || null,
				form?.startsAt || null,
				form?.endsAt || null,
				scheduledAt,
				serialized
			]
		);
		return res.insertId;
	}

	async markScheduled(eventId, scheduledAt) {
		await this.db.query('UPDATE events SET scheduled_at = ? WHERE id = ?', [scheduledAt, eventId]);
	}

	async setAnnouncePayload(eventId, payload) {
		const serialized = this.serializePayload(payload, {
			authorId: payload?.authorId || null,
			guildId: payload?.guildId || null
		});
		await this.db.query('UPDATE events SET announce_payload = ? WHERE id = ?', [serialized, eventId]);
	}

	async getEventById(eventId) {
		const [rows] = await this.db.query('SELECT * FROM events WHERE id = ? LIMIT 1', [eventId]);
		return rows?.[0] || null;
	}

	async updateParticipantCounts(eventId, { participantsDelta = 0, spectatorsDelta = 0 } = {}) {
		const eventRow = await this.getEventById(eventId);
		if (!eventRow) return null;
		let payload = {};
		if (eventRow.announce_payload) {
			try {
				payload = typeof eventRow.announce_payload === 'string' ? JSON.parse(eventRow.announce_payload) : eventRow.announce_payload;
			} catch (err) {
				payload = {};
			}
		}
		const participants = (payload.participantsCount || 0) + participantsDelta;
		const spectators = (payload.spectatorsCount || 0) + spectatorsDelta;
		const updated = { ...payload, participantsCount: participants, spectatorsCount: spectators };
		await this.setAnnouncePayload(eventId, updated);
		return { participantsCount: participants, spectatorsCount: spectators };
	}

	async listReceptionChannels(guildId) {
		if (!guildId) return [];
		const [rows] = await this.db.query('SELECT text_reception_id FROM zones WHERE guild_id = ?', [guildId]);
		return rows.map((r) => r.text_reception_id).filter(Boolean);
	}

	#parsePayload(row) {
		let payload = {};
		if (row?.announce_payload) {
		try {
		payload = typeof row.announce_payload === 'string' ? JSON.parse(row.announce_payload) : row.announce_payload;
		} catch (err) {
		payload = {};
	}
	}
		return payload;
	}

	buildEventButtons(eventId, { isFull = false } = {}) {
		return [
		new ActionRowBuilder().addComponents(
		new ButtonBuilder()
		.setCustomId(makeId('evt', 'ask', eventId))
		.setLabel('Questions')
		.setStyle(ButtonStyle.Primary),
		new ButtonBuilder()
		.setCustomId(makeId('evt', 'join', eventId))
		.setLabel('Participer')
		.setStyle(ButtonStyle.Success)
		.setDisabled(Boolean(isFull)),
		new ButtonBuilder()
		.setCustomId(makeId('evt', 'spectate', eventId))
		.setLabel('Observer')
		.setStyle(ButtonStyle.Secondary),
		)
		];
	}

	async createQuestion({ eventId, fromUserId, toUserId, question }) {
		const [res] = await this.db.query(
			'INSERT INTO event_questions (event_id, from_user_id, to_user_id, question) VALUES (?, ?, ?, ?)',
			[eventId, fromUserId || null, toUserId || null, question || null]
		);
		return res.insertId;
	}

	async getQuestionById(questionId) {
		const [rows] = await this.db.query('SELECT * FROM event_questions WHERE id = ? LIMIT 1', [questionId]);
		return rows?.[0] || null;
	}

	async answerQuestion(questionId, answer) {
		await this.db.query('UPDATE event_questions SET answer = ? WHERE id = ?', [answer || null, questionId]);
		return this.getQuestionById(questionId);
	}

	async dispatchEvent(eventId) {
		const [rows] = await this.db.query('SELECT * FROM events WHERE id = ? LIMIT 1', [eventId]);
		const row = rows?.[0];
		if (!row) return null;
		const logger = this.logger || this.client?.context?.logger || null;
		const payload = this.#parsePayload(row);
		const guildId = payload.guildId || row.guild_id;
		const channels = await this.listReceptionChannels(guildId);
		if (!channels.length) {
		logger?.warn({ eventId }, 'No reception channels for event dispatch');
		return null;
	}
		const channel = await this.client.channels.fetch(channels[0]).catch(() => null);
		if (!channel || typeof channel.send !== 'function') {
		logger?.warn({ eventId }, 'Event dispatch channel unavailable');
		return null;
	}
		const tempGroupService = this.client?.context?.services?.tempGroup;
		const guild = await this.client.guilds.fetch(guildId).catch(() => null);
		let tempGroupId = row.temp_group_id || payload.tempGroupId || null;
		const shouldCreateTempGroup =
		row.status === 'draft' && payload.createTempGroup && !tempGroupId && guild && tempGroupService;
		const participants = Array.isArray(payload.participants) ? payload.participants.slice() : [];
		const spectators = Array.isArray(payload.spectators) ? payload.spectators.slice() : [];
		const authorId = row.author_id || payload.authorId || null;
		if (shouldCreateTempGroup) {
		const group = await tempGroupService
		.createTempGroup(guild, {
		name: row.name || 'Événement',
		isOpen: true,
		participants: authorId ? [authorId] : []
		})
		.catch((err) => {
		logger?.error({ err, eventId }, 'Failed to create temp group for event');
		return null;
		});
		if (group?.id) {
		tempGroupId = group.id;
		if (authorId) {
		participants.push(String(authorId));
	}
		await this.db.query('UPDATE events SET temp_group_id = ? WHERE id = ?', [tempGroupId, eventId]);
	}
	}
		const participantsCount = payload.participantsCount || participants.length;
		const spectatorsCount = payload.spectatorsCount || spectators.length;
		const max = row.max_participants || payload.maxParticipants || null;
		const isFull = Boolean(max && participantsCount >= max);
		const embed = this.buildEventEmbed(row, { participantsCount, spectatorsCount, isFull });
		const components = this.buildEventButtons(eventId, { isFull });
		const message = await channel.send({ embeds: [embed], components, allowedMentions: { parse: [] } });
		const updatedPayload = {
		...payload,
		guildId,
		tempGroupId,
		participantsCount,
		spectatorsCount,
		participants,
		spectators,
		eventMessageId: message.id,
		eventChannelId: channel.id
		};
		await this.setAnnouncePayload(eventId, updatedPayload);
		await this.db.query('UPDATE events SET status = ?, scheduled_at = NULL WHERE id = ?', ['running', eventId]);
		return { channelId: channel.id, messageId: message.id, isFull, participantsCount, spectatorsCount };
	}

	async registerAttendance(eventId, userId, { role = 'participant' } = {}) {
		const [rows] = await this.db.query('SELECT * FROM events WHERE id = ? LIMIT 1', [eventId]);
		const row = rows?.[0];
		if (!row) return { ok: false, reason: 'not_found' };
		const payload = this.#parsePayload(row);
		const uid = String(userId);
		const participants = Array.isArray(payload.participants) ? payload.participants.slice() : [];
		const spectators = Array.isArray(payload.spectators) ? payload.spectators.slice() : [];
		const isAlreadyParticipant = participants.includes(uid);
		const max = row.max_participants || payload.maxParticipants || null;
		if (role === 'participant' && max && participants.length >= max && !isAlreadyParticipant) {
		return {
		ok: false,
		reason: 'full',
		data: { participantsCount: participants.length, spectatorsCount: spectators.length, max, row, payload }
		};
	}
		const filteredParticipants = participants.filter((id) => id !== uid);
		const filteredSpectators = spectators.filter((id) => id !== uid);
		if (role === 'participant') {
		filteredParticipants.push(uid);
		} else {
		filteredSpectators.push(uid);
	}
		const participantsCount = filteredParticipants.length;
		const spectatorsCount = filteredSpectators.length;
		const isFull = Boolean(max && participantsCount >= max);
		const updatedPayload = {
		...payload,
		participants: filteredParticipants,
		spectators: filteredSpectators,
		participantsCount,
		spectatorsCount
		};
		await this.setAnnouncePayload(eventId, updatedPayload);
		const tempGroupId = row.temp_group_id || payload.tempGroupId || null;
		const tempGroupService = this.client?.context?.services?.tempGroup;
		if (tempGroupId && tempGroupService) {
		if (role === 'participant') {
		await tempGroupService.addMembers(tempGroupId, [uid]).catch(() => {});
		} else {
		await tempGroupService.addSpectators(tempGroupId, [uid]).catch(() => {});
	}
	}
		return { ok: true, row, payload: updatedPayload, participantsCount, spectatorsCount, isFull, max };
	}

		async #getDueAnnouncementIds() {
		const [rows] = await this.db.query(
			'SELECT id FROM events WHERE scheduled_at IS NOT NULL AND scheduled_at <= NOW() AND announce_payload IS NOT NULL'
		);
		return rows.map((r) => r.id);
	}

		async dispatchAnnouncement(eventId) {
		const [rows] = await this.db.query(
			'SELECT id, announce_payload, guild_id FROM events WHERE id = ? AND scheduled_at IS NOT NULL LIMIT 1',
			[eventId]
		);
		const row = rows?.[0];
		if (!row || !row.announce_payload) return false;
		let payload = {};
		const logger = this.logger || this.client?.context?.logger || null;
		try {
			payload = typeof row.announce_payload === 'string' ? JSON.parse(row.announce_payload) : row.announce_payload;
		} catch (err) {
			logger?.error({ err, eventId }, 'Failed to parse announcement payload');
			return false;
		}
		const guildId = payload.guildId || row.guild_id;
		const channels = await this.listReceptionChannels(guildId);
		if (!channels.length) {
			logger?.warn({ eventId }, 'No reception channels for announcement');
			await this.db.query('UPDATE events SET scheduled_at = NULL WHERE id = ?', [eventId]);
			return false;
		}
		const embed = this.buildAnnouncementEmbed(payload);
		for (const channelId of channels) {
			const channel = await this.client.channels.fetch(channelId).catch(() => null);
			if (!channel || typeof channel.send !== 'function') continue;
			await channel.send({ embeds: [embed] }).catch((err) => {
				logger?.error({ err, channelId, eventId }, 'Failed to send scheduled announcement');
			});
		}
		await this.db.query('UPDATE events SET scheduled_at = NULL WHERE id = ?', [eventId]);
		return true;
	}

		async dispatchDueAnnouncements() {
		const logger = this.logger || this.client?.context?.logger || null;
		const ids = await this.#getDueAnnouncementIds();
		for (const id of ids) {
			await this.dispatchAnnouncement(id).catch((err) => {
				logger?.error({ err, eventId: id }, 'dispatchAnnouncement failed');
			});
		}
	}
	}

		module.exports = { EventService };
