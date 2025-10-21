
const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	ChannelType,
	EmbedBuilder,
	PermissionFlagsBits
} = require('discord.js');
const crypto = require('node:crypto');

const ONE_HOUR = 60 * 60 * 1000;

class EventService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
		this._schemaReady = false;
		this._drafts = new Map();
		this._settingsCache = new Map();
	}

	#logger() {
		return this.client?.context?.logger || null;
	}

	async #ensureSchema() {
		if (this._schemaReady) return;
		await this.db.query(`CREATE TABLE IF NOT EXISTS event_announcements (
			event_id BIGINT UNSIGNED NOT NULL,
			channel_id VARCHAR(32) NOT NULL,
			message_id VARCHAR(32) NOT NULL,
			zone_id BIGINT UNSIGNED NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(event_id, message_id),
			INDEX ix_event_channel (event_id, channel_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		await this.db.query(`CREATE TABLE IF NOT EXISTS event_spectators (
			event_id BIGINT UNSIGNED NOT NULL,
			user_id VARCHAR(32) NOT NULL,
			created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
			PRIMARY KEY(event_id, user_id),
			FOREIGN KEY(event_id) REFERENCES events(id) ON DELETE CASCADE
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		await this.db.query(`CREATE TABLE IF NOT EXISTS staff_panels (
			guild_id VARCHAR(32) PRIMARY KEY,
			channel_id VARCHAR(32) NOT NULL,
			message_id VARCHAR(32) NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		this._schemaReady = true;
	}

	#cleanupDrafts() {
		const now = Date.now();
		for (const [token, draft] of this._drafts.entries()) {
			if (!draft?.createdAt || now - draft.createdAt > ONE_HOUR) {
				this._drafts.delete(token);
			}
		}
	}

	#createToken() {
		return crypto.randomBytes(12).toString('hex');
	}

	createDraft(kind, userId, payload, token = null) {
		this.#cleanupDrafts();
		const resolved = token || this.#createToken();
		this._drafts.set(resolved, {
			token: resolved,
			kind,
			userId: String(userId),
			payload: payload ? { ...payload } : {},
			createdAt: Date.now()
		});
		return resolved;
	}

	getDraft(token, userId = null) {
		if (!token) return null;
		const draft = this._drafts.get(token);
		if (!draft) return null;
		if (userId && String(draft.userId) !== String(userId)) return null;
		return draft;
	}

	updateDraft(token, userId, payload = {}) {
		const draft = this.getDraft(token, userId);
		if (!draft) return null;
		draft.payload = { ...payload };
		draft.updatedAt = Date.now();
		return draft;
	}

	consumeDraft(token, userId = null) {
		const draft = this.getDraft(token, userId);
		if (!draft) return null;
		this._drafts.delete(token);
		return draft;
	}

	async #getGuildSettings(guildId) {
		if (!guildId) return null;
		const key = String(guildId);
		const cached = this._settingsCache.get(key);
		if (cached && Date.now() - cached.cachedAt < 5 * 60 * 1000) {
			return cached.data;
		}
		try {
			const [rows] = await this.db.query(
				'SELECT staff_announcements_channel_id, events_admin_channel_id FROM settings WHERE guild_id = ? LIMIT 1',
				[key]
			);
			const data = rows?.[0] || null;
			this._settingsCache.set(key, { data, cachedAt: Date.now() });
			return data;
		} catch (err) {
			this.#logger()?.warn({ err, guildId }, 'Failed to fetch guild settings for events');
			return null;
		}
	}

	async ensureStaffPanel(guild) {
		await this.#ensureSchema();
		if (!guild) return false;
		const guildId = guild.id || guild;
		const settings = await this.#getGuildSettings(guildId);
		const channelId = settings?.staff_announcements_channel_id;
		if (!channelId) return false;
		const channel = await this.client.channels.fetch(channelId).catch((err) => {
			this.#logger()?.warn({ err, channelId, guildId }, 'Failed to fetch staff announcements channel');
			return null;
		});
		if (!channel) return false;
		const layout = this.#buildStaffPanelLayout();
		const [rows] = await this.db.query(
			'SELECT message_id FROM staff_panels WHERE guild_id = ? LIMIT 1',
			[String(guildId)]
		);
		let message = null;
		const messageId = rows?.[0]?.message_id;
		if (messageId) {
			message = await channel.messages.fetch(messageId).catch(() => null);
			if (message) {
				await message
					.edit(layout)
					.catch((err) => this.#logger()?.warn({ err, messageId, guildId }, 'Failed to edit staff panel message'));
			}
		}
		if (!message) {
			message = await channel
				.send(layout)
				.catch((err) => {
					this.#logger()?.warn({ err, guildId, channelId }, 'Failed to send staff panel message');
					return null;
				});
		}
		if (!message) return false;
		await this.db.query(
			'INSERT INTO staff_panels (guild_id, channel_id, message_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), message_id = VALUES(message_id), updated_at = NOW()',
			[String(guildId), String(channelId), String(message.id)]
		);
		return true;
	}

	#buildStaffPanelLayout() {
		const embed = new EmbedBuilder()
			.setTitle('Panneau annonces staff')
			.setDescription('➤ Publier une annonce pour toutes les zones
➤ Créer et annoncer un événement staff')
			.setColor(0x5865f2);
		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId('announce:openModal').setLabel('Nouvelle annonce').setStyle(ButtonStyle.Primary),
			new ButtonBuilder().setCustomId('event:openModal').setLabel('Nouvel événement').setStyle(ButtonStyle.Success)
		);
		return { embeds: [embed], components: [row] };
	}

	#sanitizeTitle(value) {
		return String(value || '').trim().slice(0, 256);
	}

	#sanitizeContent(value) {
		return String(value || '').trim().slice(0, 4000);
	}

	#parseDateInput(raw) {
		if (!raw) return null;
		const parts = String(raw)
			.trim()
			.split(/[\/\-.]/)
			.map((v) => v.trim())
			.filter(Boolean);
		if (parts.length !== 3) return null;
		let [day, month, year] = parts;
		if (year.length === 2) {
			year = Number(year) + 2000;
		}
		const d = Number(day);
		const m = Number(month);
		const y = Number(year);
		if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return null;
		if (d < 1 || d > 31 || m < 1 || m > 12) return null;
		return { day: d, month: m, year: y };
	}

	#parseTimeInput(raw) {
		if (!raw) return null;
		const match = String(raw).trim().match(/^([0-2]?\d):([0-5]\d)$/);
		if (!match) return null;
		const hour = Number(match[1]);
		const minute = Number(match[2]);
		if (hour > 23) return null;
		return { hour, minute };
	}

	#parseParisDateTime(datePart, timePart) {
		const date = typeof datePart === 'string' ? this.#parseDateInput(datePart) : datePart;
		const time = typeof timePart === 'string' ? this.#parseTimeInput(timePart) : timePart;
		if (!date) return null;
		const hour = time?.hour ?? 0;
		const minute = time?.minute ?? 0;
		const base = Date.UTC(date.year, date.month - 1, date.day, hour, minute, 0, 0);
		const dtf = new Intl.DateTimeFormat('fr-FR', {
			timeZone: 'Europe/Paris',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false
		});
		let result = new Date(base);
		for (let i = 0; i < 5; i++) {
			const parts = dtf.formatToParts(result);
			const map = {};
			for (const part of parts) {
				if (part.type !== 'literal') {
					map[part.type] = part.value;
				}
			}
			const currentUtc = Date.UTC(
				Number(map.year),
				Number(map.month) - 1,
				Number(map.day),
				Number(map.hour),
				Number(map.minute)
			);
			const desiredUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
			const diff = desiredUtc - currentUtc;
			if (Math.abs(diff) < 1000) {
				result = new Date(result.getTime() + diff);
				break;
			}
			result = new Date(result.getTime() + diff);
		}
		return result;
	}

	#formatParisDate(date) {
		if (!date) return null;
		const dtf = new Intl.DateTimeFormat('fr-FR', {
			timeZone: 'Europe/Paris',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false
		});
		return dtf.format(date);
	}

	resolveSchedule(dateInput, timeInput) {
		return this.#parseParisDateTime(dateInput, timeInput);
	}

	#resolvePayloadType(payload) {
		return payload?.type === 'event' ? 'event' : 'announcement';
	}

	#buildAnnouncementEmbed(payload, options = {}) {
		const title = this.#sanitizeTitle(payload?.title || payload?.name);
		const description = this.#sanitizeContent(payload?.content || payload?.description);
		const embed = new EmbedBuilder().setTitle(title || 'Annonce staff').setDescription(description || '');
		if (options?.scheduledAt) {
			embed.setFooter({ text: `Diffusion programmée le ${this.#formatParisDate(options.scheduledAt)}` });
		}
		embed.setColor(0x5865f2);
		return embed;
	}

	#buildEventEmbed(payload, state = {}) {
		const embed = new EmbedBuilder();
		embed.setTitle(this.#sanitizeTitle(payload?.title || payload?.name) || 'Événement staff');
		const description = this.#sanitizeContent(payload?.description || payload?.content);
		if (description) {
			embed.setDescription(description);
		}
		embed.setColor(0xf29f05);
		if (payload?.game) {
			embed.addFields({ name: 'Jeu', value: `🎮 ${payload.game}`, inline: true });
		}
		const startsAt = state?.startsAt ? new Date(state.startsAt) : null;
		if (startsAt) {
			embed.addFields({ name: 'Date prévue', value: `🗓️ ${this.#formatParisDate(startsAt)}`, inline: true });
		} else if (payload?.expectedDate) {
			embed.addFields({ name: 'Date prévue', value: `🗓️ ${payload.expectedDate}`, inline: true });
		}
		if (payload?.expectedTime && !startsAt) {
			embed.addFields({ name: 'Heure', value: `⏰ ${payload.expectedTime}`, inline: true });
		}
		if (payload?.expectedDuration) {
			embed.addFields({ name: 'Durée estimée', value: `⌛ ${payload.expectedDuration}`, inline: true });
		}
		const participants = Number(state?.participants ?? 0);
		const spectators = Number(state?.spectators ?? 0);
		const max = Number(payload?.maxParticipants ?? state?.maxParticipants || 0) || null;
		let participationLine = `👥 ${participants}`;
		if (max) {
			participationLine += ` / ${max}`;
			if (participants >= max) participationLine += ' (complet)';
		}
		if (spectators > 0) {
			participationLine += `
👀 ${spectators} spectateur${spectators > 1 ? 's' : ''}`;
		}
		embed.addFields({ name: 'Participants', value: participationLine, inline: false });
		if (state?.scheduledAt) {
			embed.setFooter({ text: `Annonce programmée le ${this.#formatParisDate(state.scheduledAt)}` });
		}
		return embed;
	}

	#buildEventButtons(eventId, options = {}) {
		const disabledJoin = options?.disabledJoin === true;
		const disabledAll = options?.disabled === true;
		return new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`event:ask:${eventId}`)
				.setLabel('Poser une question')
				.setStyle(ButtonStyle.Secondary)
				.setDisabled(disabledAll),
			new ButtonBuilder()
				.setCustomId(`event:join:${eventId}`)
				.setLabel('Participer')
				.setStyle(ButtonStyle.Success)
				.setDisabled(disabledAll || disabledJoin),
			new ButtonBuilder()
				.setCustomId(`event:spectate:${eventId}`)
				.setLabel('Observer')
				.setStyle(ButtonStyle.Primary)
				.setDisabled(disabledAll)
		);
	}

	announceToAllZonesPreview(payload, options = {}) {
		const kind = this.#resolvePayloadType(payload);
		if (kind === 'event') {
			return {
				embeds: [
					this.#buildEventEmbed(payload, {
						participants: 0,
						spectators: 0,
						scheduledAt: options?.state?.scheduledAt || null,
						maxParticipants: payload?.maxParticipants
					})
				],
				components: [this.#buildEventButtons(options?.eventId || 0, { disabled: true })]
			};
		}
		return {
			embeds: [this.#buildAnnouncementEmbed(payload, options?.state)],
			components: []
		};
	}

	async dispatchAnnouncement(payload, scheduledAt = null, options = {}) {
		await this.#ensureSchema();
		if (!payload) throw new Error('payload missing');
		const kind = this.#resolvePayloadType(payload);
		const authorId = String(payload?.authorId || options?.authorId || '') || null;
		const title = this.#sanitizeTitle(payload?.title || payload?.name);
		const description = this.#sanitizeContent(payload?.content || payload?.description);
		let startsAt = null;
		if (payload?.startsAt) {
			startsAt = new Date(payload.startsAt);
		} else if (payload?.expectedDate) {
			startsAt = this.#parseParisDateTime(payload.expectedDate, payload.expectedTime || null);
			if (startsAt) {
				payload.startsAt = startsAt.toISOString();
			}
		}
		const scheduleValue = scheduledAt instanceof Date ? scheduledAt : scheduledAt ? new Date(scheduledAt) : null;
		const columns = ['name', 'status', 'description', 'announce_payload', 'author_id'];
		const values = [title || (kind === 'event' ? 'Événement staff' : 'Annonce staff'), 'draft', description || null, null, authorId];
		if (scheduleValue) {
			columns.push('scheduled_at');
			values.push(scheduleValue);
		}
		if (kind === 'event') {
			columns.push('game');
			values.push(payload?.game || null);
			columns.push('starts_at');
			values.push(startsAt || null);
			const max = Number(payload?.maxParticipants ?? NaN);
			columns.push('max_participants');
			values.push(Number.isFinite(max) && max > 0 ? Math.floor(max) : null);
			if (payload?.createTempGroup) {
				const guild = options?.guild || null;
				const tempGroupService = this.client?.context?.services?.tempGroup || null;
				if (tempGroupService && guild?.id) {
					try {
						const res = await tempGroupService.createTempGroup(guild, {
							name: title,
							isOpen: true,
							participants: authorId ? [authorId] : [],
							authorId
						});
						if (res?.groupId) {
							payload.tempGroupId = res.groupId;
						}
					} catch (err) {
						this.#logger()?.warn({ err }, 'Failed to create temp group for event');
					}
				}
			}
			columns.push('temp_group_id');
			values.push(payload?.tempGroupId || null);
		} else {
			payload.createTempGroup = false;
		}
		const payloadToStore = { ...payload, type: kind };
		if (authorId) {
			payloadToStore.authorId = authorId;
		}
		if (!payloadToStore.guildId && options?.guild?.id) {
			payloadToStore.guildId = String(options.guild.id);
		}
		if (scheduleValue) {
			payloadToStore.scheduledAt = scheduleValue.toISOString();
		}
		values[3] = JSON.stringify(payloadToStore);
		const placeholders = columns.map(() => '?').join(', ');
		const sql = `INSERT INTO events (${columns.join(', ')}) VALUES (${placeholders})`;
		const [res] = await this.db.query(sql, values);
		const eventId = res.insertId;
		if (!scheduleValue) {
			await this.announceToAllZones(eventId);
		}
		return { eventId, scheduled: Boolean(scheduleValue), scheduledAt: scheduleValue };
	}

	async #getZones() {
		const [rows] = await this.db.query('SELECT id, text_reception_id FROM zones');
		return rows || [];
	}

	#parsePayload(raw) {
		if (!raw) return null;
		if (typeof raw === 'object') return raw;
		try {
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	async #getEventRow(eventId) {
		const [rows] = await this.db.query('SELECT * FROM events WHERE id = ? LIMIT 1', [eventId]);
		const row = rows?.[0] || null;
		if (!row) return null;
		row.announce_payload = this.#parsePayload(row.announce_payload);
		return row;
	}

	async #getAnnouncementState(eventRow) {
		const [[pCount]] = await this.db.query('SELECT COUNT(*) AS c FROM event_participants WHERE event_id = ?', [eventRow.id]);
		const [[sCount]] = await this.db.query('SELECT COUNT(*) AS c FROM event_spectators WHERE event_id = ?', [eventRow.id]);
		return { participants: Number(pCount?.c || 0), spectators: Number(sCount?.c || 0) };
	}

	async announceToAllZones(eventOrId, options = {}) {
		await this.#ensureSchema();
		let eventRow = null;
		if (typeof eventOrId === 'object' && eventOrId) {
			eventRow = eventOrId;
		} else {
			eventRow = await this.#getEventRow(eventOrId);
		}
		if (!eventRow) return false;
		const payload = eventRow.announce_payload;
		if (!payload) return false;
		const kind = this.#resolvePayloadType(payload);
		const state = await this.#getAnnouncementState(eventRow);
		const scheduledAt = eventRow.scheduled_at ? new Date(eventRow.scheduled_at) : null;
		let messagePayload = null;
		if (kind === 'event') {
			messagePayload = {
				embeds: [
					this.#buildEventEmbed(payload, {
						participants: state.participants,
						spectators: state.spectators,
						scheduledAt,
						maxParticipants: payload?.maxParticipants ?? eventRow.max_participants,
						startsAt: eventRow.starts_at
					})
				],
				components: [
					this.#buildEventButtons(eventRow.id, {
						disabledJoin:
							Number(payload?.maxParticipants ?? eventRow.max_participants || 0) > 0 &&
							state.participants >= Number(payload?.maxParticipants ?? eventRow.max_participants || 0)
					})
				]
			};
		} else {
			messagePayload = {
				embeds: [this.#buildAnnouncementEmbed(payload, { scheduledAt })],
				components: []
			};
		}
		const zones = await this.#getZones();
		for (const zone of zones) {
			if (!zone?.text_reception_id) continue;
			const channel = await this.client.channels.fetch(zone.text_reception_id).catch(() => null);
			if (!channel) continue;
			const [existing] = await this.db.query(
				'SELECT message_id FROM event_announcements WHERE event_id = ? AND channel_id = ? LIMIT 1',
				[eventRow.id, String(zone.text_reception_id)]
			);
			let message = null;
			if (existing?.[0]?.message_id) {
				message = await channel.messages.fetch(existing[0].message_id).catch(() => null);
				if (message) {
					await message.edit(messagePayload).catch((err) => {
						this.#logger()?.warn({ err, eventId: eventRow.id, messageId: existing[0].message_id }, 'Failed to update event announcement');
					});
					continue;
				}
			}
			if (options?.refreshOnly) continue;
			message = await channel.send(messagePayload).catch((err) => {
				this.#logger()?.warn({ err, eventId: eventRow.id, channelId: zone.text_reception_id }, 'Failed to send event announcement');
				return null;
			});
			if (message) {
				await this.db.query(
					'INSERT INTO event_announcements (event_id, channel_id, message_id, zone_id) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE channel_id = VALUES(channel_id), zone_id = VALUES(zone_id)',
					[eventRow.id, String(zone.text_reception_id), String(message.id), zone.id || null]
				);
			}
		}
		if (eventRow.scheduled_at) {
			await this.db.query('UPDATE events SET scheduled_at = NULL WHERE id = ?', [eventRow.id]);
		}
		return true;
	}

	async updateEventAnnouncementMessages(eventId) {
		await this.#ensureSchema();
		const eventRow = await this.#getEventRow(eventId);
		if (!eventRow) return false;
		const payload = eventRow.announce_payload;
		if (!payload || this.#resolvePayloadType(payload) !== 'event') return false;
		const state = await this.#getAnnouncementState(eventRow);
		const scheduledAt = eventRow.scheduled_at ? new Date(eventRow.scheduled_at) : null;
		const messagePayload = {
			embeds: [
				this.#buildEventEmbed(payload, {
					participants: state.participants,
					spectators: state.spectators,
					scheduledAt,
					maxParticipants: payload?.maxParticipants ?? eventRow.max_participants,
					startsAt: eventRow.starts_at
				})
			],
			components: [
				this.#buildEventButtons(eventRow.id, {
					disabledJoin:
						Number(payload?.maxParticipants ?? eventRow.max_participants || 0) > 0 &&
						state.participants >= Number(payload?.maxParticipants ?? eventRow.max_participants || 0)
				})
			]
		};
		const [messages] = await this.db.query('SELECT * FROM event_announcements WHERE event_id = ?', [eventRow.id]);
		for (const row of messages || []) {
			const channel = await this.client.channels.fetch(row.channel_id).catch(() => null);
			if (!channel) {
				await this.db.query('DELETE FROM event_announcements WHERE event_id = ? AND channel_id = ?', [eventRow.id, row.channel_id]);
				continue;
			}
			const message = await channel.messages.fetch(row.message_id).catch(() => null);
			if (!message) {
				await this.db.query('DELETE FROM event_announcements WHERE event_id = ? AND message_id = ?', [eventRow.id, row.message_id]);
				continue;
			}
			await message.edit(messagePayload).catch((err) => {
				this.#logger()?.warn({ err, eventId: eventRow.id, messageId: row.message_id }, 'Failed to refresh event announcement');
			});
		}
		return true;
	}

	async dispatchScheduledAnnouncements() {
		await this.#ensureSchema();
		const [rows] = await this.db.query(
			"SELECT id FROM events WHERE status = 'draft' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()"
		);
		for (const row of rows || []) {
			await this.announceToAllZones(row.id).catch((err) => {
				this.#logger()?.error({ err, eventId: row.id }, 'Failed to dispatch scheduled announcement');
			});
		}
	}

	async #resolveAnnouncementZone(eventId, channelId) {
		const [rows] = await this.db.query(
			'SELECT zone_id FROM event_announcements WHERE event_id = ? AND channel_id = ? LIMIT 1',
			[eventId, String(channelId)]
		);
		return rows?.[0]?.zone_id || null;
	}

	async joinEvent(eventId, userId, channelId) {
		await this.#ensureSchema();
		const eventRow = await this.#getEventRow(eventId);
		if (!eventRow) return { ok: false, message: 'Événement introuvable.' };
		const payload = eventRow.announce_payload;
		if (!payload || this.#resolvePayloadType(payload) !== 'event') {
			return { ok: false, message: 'Cet événement ne prend pas d’inscriptions.' };
		}
		const zoneId = await this.#resolveAnnouncementZone(eventId, channelId);
		if (!zoneId) {
			return { ok: false, message: 'Zone inconnue pour cet événement.' };
		}
		const [existing] = await this.db.query(
			'SELECT 1 FROM event_participants WHERE event_id = ? AND user_id = ? LIMIT 1',
			[eventId, String(userId)]
		);
		if (existing?.length) {
			return { ok: true, message: 'Tu es déjà inscrit·e à cet événement.' };
		}
		const [[countRow]] = await this.db.query('SELECT COUNT(*) AS c FROM event_participants WHERE event_id = ?', [eventId]);
		const count = Number(countRow?.c || 0);
		const max = Number(payload?.maxParticipants ?? eventRow.max_participants || 0);
		if (max > 0 && count >= max) {
			return { ok: false, message: 'Événement complet.' };
		}
		await this.db.query(
			'INSERT INTO event_participants (event_id, user_id, zone_id, joined_at) VALUES (?, ?, ?, NOW())',
			[eventId, String(userId), zoneId]
		);
		if (eventRow.temp_group_id) {
			const tempGroupService = this.client?.context?.services?.tempGroup || null;
			if (tempGroupService?.joinGroup) {
				await tempGroupService.joinGroup(eventRow.temp_group_id, userId).catch(() => null);
			}
		}
		await this.updateEventAnnouncementMessages(eventId);
		return { ok: true, message: 'Inscription confirmée !' };
	}

	async spectateEvent(eventId, userId, channelId) {
		await this.#ensureSchema();
		const eventRow = await this.#getEventRow(eventId);
		if (!eventRow) return { ok: false, message: 'Événement introuvable.' };
		const payload = eventRow.announce_payload;
		if (!payload || this.#resolvePayloadType(payload) !== 'event') {
			return { ok: false, message: 'Cet événement ne prend pas d’observateurs.' };
		}
		const [participant] = await this.db.query(
			'SELECT 1 FROM event_participants WHERE event_id = ? AND user_id = ? LIMIT 1',
			[eventId, String(userId)]
		);
		if (participant?.length) {
			return { ok: true, message: 'Tu participes déjà à cet événement.' };
		}
		const [existing] = await this.db.query(
			'SELECT 1 FROM event_spectators WHERE event_id = ? AND user_id = ? LIMIT 1',
			[eventId, String(userId)]
		);
		if (existing?.length) {
			return { ok: true, message: 'Tu observes déjà cet événement.' };
		}
		await this.db.query('INSERT INTO event_spectators (event_id, user_id) VALUES (?, ?)', [eventId, String(userId)]);
		if (eventRow.temp_group_id) {
			const tempGroupService = this.client?.context?.services?.tempGroup || null;
			if (tempGroupService?.spectateGroup) {
				await tempGroupService.spectateGroup(eventRow.temp_group_id, userId).catch(() => null);
			}
		}
		await this.updateEventAnnouncementMessages(eventId);
		return { ok: true, message: 'Mode spectateur activé.' };
	}

	async recordQuestion(eventId, fromUserId, question) {
		await this.#ensureSchema();
		const eventRow = await this.#getEventRow(eventId);
		if (!eventRow) return null;
		const sanitized = this.#sanitizeContent(question);
		const toUserId = eventRow.author_id || null;
		const [res] = await this.db.query(
			'INSERT INTO event_questions (event_id, from_user_id, to_user_id, question) VALUES (?, ?, ?, ?)',
			[eventId, String(fromUserId), String(toUserId || ''), sanitized]
		);
		return {
			id: res.insertId,
			event: eventRow,
			fromUserId: String(fromUserId),
			toUserId,
			question: sanitized
		};
	}

	async getQuestion(questionId) {
		const [rows] = await this.db.query('SELECT * FROM event_questions WHERE id = ? LIMIT 1', [questionId]);
		return rows?.[0] || null;
	}

	async recordAnswer(questionId, answer) {
		await this.db.query('UPDATE event_questions SET answer = ? WHERE id = ?', [this.#sanitizeContent(answer), questionId]);
	}

	async deliverQuestionToAuthor(meta) {
		if (!meta?.event) return false;
		const authorId = meta.toUserId || meta.event.author_id;
		if (!authorId) return false;
		const embed = new EmbedBuilder()
			.setTitle('Nouvelle question sur votre événement')
			.setDescription(meta.question)
			.setColor(0x5865f2);
		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`event:questionReply:${meta.id}`).setLabel('Répondre').setStyle(ButtonStyle.Primary)
		);
		const user = await this.client.users.fetch(authorId).catch(() => null);
		if (user) {
			try {
				await user.send({
					content: `📬 Question de <@${meta.fromUserId}> concernant **${meta.event.name}**`,
					embeds: [embed],
					components: [row]
				});
				return true;
			} catch (err) {
				this.#logger()?.warn({ err }, 'Failed to DM event question to author');
			}
		}
		const guildId =
			meta.event.guild_id ||
			meta.event.announce_payload?.guildId ||
			meta.event.announce_payload?.guild_id ||
			null;
		const guild = guildId ? await this.client.guilds.fetch(guildId).catch(() => null) : null;
		if (!guild) return false;
		const channel = await this.#resolveEventsAdminChannel(guild);
		if (!channel) return false;
		await channel
			.send({
				content: `<@${authorId}> nouvelle question de <@${meta.fromUserId}> pour **${meta.event.name}**`,
				embeds: [embed],
				components: [row]
			})
			.catch(() => {});
		return true;
	}

	async #resolveEventsAdminChannel(guild) {
		const settings = await this.#getGuildSettings(guild.id);
		if (settings?.events_admin_channel_id) {
			const channel = await this.client.channels.fetch(settings.events_admin_channel_id).catch(() => null);
			if (channel) return channel;
		}
		await guild.channels.fetch().catch(() => null);
		const category = guild.channels.cache.find(
			(ch) => ch.type === ChannelType.GuildCategory && ch.name.toLowerCase() === 'notification'
		);
		if (category) {
			let channel = category.children?.cache?.find(
				(ch) => ch.type === ChannelType.GuildText && ch.name.toLowerCase() === 'events-admin'
			);
			if (!channel) {
				channel = await guild.channels
					.create({
						name: 'events-admin',
						type: ChannelType.GuildText,
						parent: category.id,
						permissionOverwrites: [
							{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
							{
								id: this.client.user.id,
								allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
							}
						]
					})
					.catch(() => null);
			}
			if (channel) return channel;
		}
		const fallback = guild.channels.cache.find(
			(ch) => ch.type === ChannelType.GuildText && ch.name.toLowerCase() === 'events-admin'
		);
		return fallback || null;
	}

        async deliverAnswerToAsker(questionRow, answer) {
                const askerId = questionRow?.from_user_id;
                if (!askerId) return false;
                const embed = new EmbedBuilder().setTitle('Réponse à ta question').setDescription(answer).setColor(0x57f287);
                const user = await this.client.users.fetch(askerId).catch(() => null);
                if (user) {
                        try {
                                await user.send({ embeds: [embed] });
                                return true;
                        } catch (err) {
                                this.#logger()?.warn({ err }, 'Failed to DM answer to asker');
                        }
                }
		const eventRow = await this.#getEventRow(questionRow.event_id);
		const guildId =
			eventRow?.guild_id ||
			eventRow?.announce_payload?.guildId ||
			eventRow?.announce_payload?.guild_id ||
			null;
		if (!guildId) return false;
		const guild = await this.client.guilds.fetch(guildId).catch(() => null);
                if (!guild) return false;
                const channel = await this.#resolveEventsAdminChannel(guild);
                if (!channel) return false;
                await channel
                        .send({
                                content: `<@${askerId}> réponse pour ta question sur **${eventRow.name}**`,
                                embeds: [embed]
                        })
                        .catch(() => {});
                return true;
        }

        async getEvent(eventId) {
                return this.#getEventRow(eventId);
        }
}

module.exports = { EventService };
