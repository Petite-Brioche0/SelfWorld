const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle
} = require('discord.js');
const { ensureFallback } = require('../utils/channels');
const { parseId, makeId } = require('../utils/ids');

class EventService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
	}

	#parseParisSchedule(dateStr, timeStr) {
		const [day, month, year] = (dateStr || '').split('/').map(n => Number(n));
		const [hour, minute] = (timeStr || '').split(':').map(n => Number(n));
		if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) return null;
		const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
		const formatter = new Intl.DateTimeFormat('en-US', {
			timeZone: 'Europe/Paris',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hour12: false
		});
		const parts = formatter.formatToParts(new Date(utcGuess)).reduce((acc, part) => {
			if (part.type !== 'literal') acc[part.type] = Number(part.value);
			return acc;
		}, {});
		const zoned = Date.UTC(
			parts.year,
			(parts.month || 1) - 1,
			parts.day || 1,
			parts.hour || 0,
			parts.minute || 0,
			parts.second || 0
		);
		const offset = zoned - utcGuess;
		return new Date(utcGuess - offset);
	}

	#buildPreviewComponents(namespace, eventId) {
		return [
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(makeId(`${namespace}:preview:cancel`, eventId))
					.setStyle(ButtonStyle.Secondary)
					.setLabel('Cancel'),
				new ButtonBuilder()
					.setCustomId(makeId(`${namespace}:preview:edit`, eventId))
					.setStyle(ButtonStyle.Secondary)
					.setLabel('Edit'),
				new ButtonBuilder()
					.setCustomId(makeId(`${namespace}:preview:confirm`, eventId))
					.setStyle(ButtonStyle.Success)
					.setLabel('Send'),
				new ButtonBuilder()
					.setCustomId(makeId(`${namespace}:preview:schedule`, eventId))
					.setStyle(ButtonStyle.Primary)
					.setLabel('Schedule')
			)
		];
	}

	async #getCounts(eventId) {
		const [rows] = await this.db.query(
			'SELECT role, COUNT(*) AS c FROM event_participants WHERE event_id=? GROUP BY role',
			[eventId]
		);
		let participantsCount = 0;
		let spectatorsCount = 0;
		for (const row of rows || []) {
			if (row.role === 'spectator') {
				spectatorsCount = Number(row.c) || 0;
			} else {
				participantsCount = Number(row.c) || 0;
			}
		}
		return { participantsCount, spectatorsCount };
	}

	async #resolveZoneId(eventRow, interaction) {
		let guildId = interaction?.guildId || null;
		if (!guildId && eventRow?.announce_payload) {
			try {
				const meta = JSON.parse(eventRow.announce_payload);
				if (meta?.guildId) guildId = meta.guildId;
			} catch (err) {
				// ignore parsing errors
			}
		}
		if (!guildId) return null;
		const [rows] = await this.db.query('SELECT id FROM zones WHERE guild_id = ? ORDER BY id LIMIT 1', [guildId]);
		return rows?.[0]?.id || null;
	}

	#buildComponents(eventId, { isFull = false } = {}) {
		const joinButton = new ButtonBuilder()
			.setCustomId(makeId('evt', 'join', eventId))
			.setStyle(ButtonStyle.Primary)
			.setLabel('Join')
			.setDisabled(!!isFull);
		const spectateButton = new ButtonBuilder()
			.setCustomId(makeId('evt', 'spectate', eventId))
			.setStyle(ButtonStyle.Secondary)
			.setLabel('Spectate');
		return [new ActionRowBuilder().addComponents(joinButton, spectateButton)];
	}

	async #updateEventMessage(interaction, eventRow, counts) {
		if (!interaction?.message) return false;
		const isFull = eventRow?.max_participants
			? counts.participantsCount >= Number(eventRow.max_participants)
			: false;
		const embed = this.buildEventEmbed(eventRow, {
			participantsCount: counts.participantsCount,
			spectatorsCount: counts.spectatorsCount,
			isFull
		});
		const components = this.#buildComponents(eventRow.id, { isFull });
		await interaction.message.edit({ embeds: [embed], components }).catch(() => {});
		return isFull;
	}

	buildAnnouncementEmbed(payload) {
		const embed = new EmbedBuilder().setTitle(payload?.title || 'Announcement');
		if (payload?.content) embed.setDescription(payload.content);
		return embed;
	}

	buildEventEmbed(eventRow, { participantsCount = 0, spectatorsCount = 0, isFull = false } = {}) {
		const embed = new EmbedBuilder().setTitle(eventRow?.name || 'Event');
		if (eventRow?.game) embed.addFields({ name: 'Game', value: eventRow.game, inline: true });
		if (eventRow?.starts_at) {
			const timestamp = Math.floor(new Date(eventRow.starts_at).getTime() / 1000);
			embed.addFields({ name: 'Start', value: `<t:${timestamp}:f>`, inline: true });
		}
		if (eventRow?.ends_at) {
			const timestamp = Math.floor(new Date(eventRow.ends_at).getTime() / 1000);
			embed.addFields({ name: 'End', value: `<t:${timestamp}:f>`, inline: true });
		}
		if (eventRow?.max_participants) {
			embed.addFields({ name: 'Slots', value: `${participantsCount}/${eventRow.max_participants}`, inline: true });
		}
		if (eventRow?.description) embed.setDescription(eventRow.description);
		embed.addFields({ name: 'Participants', value: `${participantsCount}`, inline: true });
		embed.addFields({ name: 'Spectators', value: `${spectatorsCount}`, inline: true });
		if (isFull) embed.setFooter({ text: 'Full' });
		return embed;
	}

	buildAnnouncementModal(eventId, payload = null) {
		const modal = new ModalBuilder()
			.setCustomId(makeId('ann:modal', eventId))
			.setTitle(payload ? 'Edit announcement' : 'New announcement')
			.addComponents(
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('title')
						.setLabel('Title')
						.setStyle(TextInputStyle.Short)
						.setRequired(true)
						.setValue(payload?.title || '')
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('content')
						.setLabel('Content')
						.setStyle(TextInputStyle.Paragraph)
						.setRequired(true)
						.setValue(payload?.content || '')
				)
			);
		return modal;
	}

	buildEventModal(eventId, payload = null) {
		const modal = new ModalBuilder()
			.setCustomId(makeId('evt:modal', eventId))
			.setTitle(payload ? 'Edit event' : 'New event')
			.addComponents(
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('title')
						.setLabel('Title')
						.setStyle(TextInputStyle.Short)
						.setRequired(true)
						.setValue(payload?.title || '')
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('game')
						.setLabel('Game')
						.setStyle(TextInputStyle.Short)
						.setRequired(false)
						.setValue(payload?.game || '')
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('description')
						.setLabel('Description')
						.setStyle(TextInputStyle.Paragraph)
						.setRequired(false)
						.setValue(payload?.description || '')
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('datetime')
						.setLabel('Date JJ/MM/AAAA HH:MM Europe/Paris')
						.setStyle(TextInputStyle.Short)
						.setRequired(false)
						.setValue(payload?.datetime || '')
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('max_temp')
						.setLabel('Max participants ; temp-group (oui/non)')
						.setStyle(TextInputStyle.Short)
						.setRequired(false)
						.setValue(payload?.maxTemp || '')
				)
			);
		return modal;
	}

	async saveAnnouncementDraft(payload, { authorId, guildId, scheduledAt = null, eventId = null } = {}) {
		const jsonPayload = JSON.stringify({ title: payload?.title || 'Announcement', content: payload?.content || '', guildId });
		const scheduledValue = scheduledAt ? new Date(scheduledAt) : null;
		if (eventId) {
			await this.db.query(
				'UPDATE events SET name=?, description=?, author_id=?, scheduled_at=?, announce_payload=? WHERE id=?',
				[payload?.title || 'Announcement', payload?.content || '', authorId || null, scheduledValue, jsonPayload, eventId]
			);
			return eventId;
		}
		const [res] = await this.db.query(
			'INSERT INTO events (name, status, description, author_id, scheduled_at, announce_payload, starts_at, ends_at, max_participants, temp_group_id) VALUES (?, "draft", ?, ?, ?, ?, NULL, NULL, NULL, NULL)',
			[payload?.title || 'Announcement', payload?.content || '', authorId || null, scheduledValue, jsonPayload]
		);
		return res.insertId;
	}

	async saveEventDraft(form, { authorId, guildId, scheduledAt = null, createTempGroup = false, eventId = null } = {}) {
		const startsAt = form?.startsAt || null;
		const endsAt = form?.endsAt || null;
		const description = form?.description || null;
		const game = form?.game || null;
		const maxParticipants = form?.maxParticipants || null;
		const tempGroupId = form?.tempGroupId || null;
		const payloadTempGroup = createTempGroup ? 1 : 0;
		const metaPayload = JSON.stringify({ guildId: guildId || null, createTempGroup: !!createTempGroup });
		const scheduledValue = scheduledAt ? new Date(scheduledAt) : null;
		if (eventId) {
			await this.db.query(
				'UPDATE events SET name=?, description=?, author_id=?, scheduled_at=?, game=?, starts_at=?, ends_at=?, max_participants=?, temp_group_id=?, announce_payload=? WHERE id=?',
				[
					form?.title || 'Event',
					description,
					authorId || null,
					scheduledValue,
					game,
					startsAt,
					endsAt,
					maxParticipants,
					tempGroupId || (payloadTempGroup ? -1 : null),
					metaPayload,
					eventId
				]
			);
			return eventId;
		}

		const [res] = await this.db.query(
			'INSERT INTO events (name, status, description, author_id, scheduled_at, game, starts_at, ends_at, max_participants, temp_group_id, announce_payload) VALUES (?, "draft", ?, ?, ?, ?, ?, ?, ?, ?, ?)',
			[
				form?.title || 'Event',
				description,
				authorId || null,
				scheduledValue,
				game,
				startsAt,
				endsAt,
				maxParticipants,
				tempGroupId || (payloadTempGroup ? -1 : null),
				metaPayload
			]
		);
		return res.insertId;
	}

	async markScheduled(eventId, scheduledAtUTC) {
		const scheduledValue = scheduledAtUTC ? new Date(scheduledAtUTC) : null;
		await this.db.query('UPDATE events SET scheduled_at=? WHERE id=?', [scheduledValue, eventId]);
	}

	async getEventById(eventId) {
		const [rows] = await this.db.query('SELECT * FROM events WHERE id=? LIMIT 1', [eventId]);
		return rows?.[0] || null;
	}

	async listReceptionChannels(guildId) {
		const channels = [];
		const targetGuildId = guildId || this.client.guilds.cache.first()?.id || null;
		if (targetGuildId) {
			const [rows] = await this.db.query(
				'SELECT text_reception_id FROM zones WHERE guild_id=? AND text_reception_id IS NOT NULL',
				[targetGuildId]
			);
			for (const row of rows || []) {
				const ch = await this.client.channels.fetch(row.text_reception_id).catch(() => null);
				if (ch) channels.push(ch);
			}
		}
		if (!channels.length) {
			const guild = targetGuildId ? await this.client.guilds.fetch(String(targetGuildId)).catch(() => null) : null;
			if (guild) {
				const fallback = await ensureFallback(guild, 'events-admin').catch(() => null);
				if (fallback) channels.push(fallback);
			}
		}
		return channels;
	}

	async #sendWithFallback(channels, message, guildId) {
		let delivered = false;
		for (const ch of channels || []) {
			try {
				await ch.send(message);
				delivered = true;
			} catch (err) {
				this.client?.context?.logger?.warn({ err }, 'Failed to send event message');
			}
		}
		if (delivered || !guildId) return delivered;
		const guild = await this.client.guilds.fetch(String(guildId)).catch(() => null);
		if (!guild) return delivered;
		const fallback = await ensureFallback(guild, 'events-admin').catch(() => null);
		if (!fallback) return delivered;
		return fallback
			.send(message)
			.then(() => true)
			.catch(err => {
				this.client?.context?.logger?.warn({ err }, 'Fallback delivery failed');
				return delivered;
			});
	}

	async dispatchAnnouncement(eventId) {
		const row = await this.getEventById(eventId);
		if (!row) return false;
		const payload = row.announce_payload ? JSON.parse(row.announce_payload) : { title: row.name, content: row.description };
		const embed = this.buildAnnouncementEmbed(payload);
		const channels = await this.listReceptionChannels(payload.guildId || null);
		await this.#sendWithFallback(channels, { embeds: [embed] }, payload.guildId || null);
		await this.db.query('UPDATE events SET status="running", scheduled_at=NULL WHERE id=?', [eventId]);
		return true;
	}

	async dispatchEvent(eventId) {
		const row = await this.getEventById(eventId);
		if (!row) return false;
		const meta = row.announce_payload ? JSON.parse(row.announce_payload) : {};
		const embed = this.buildEventEmbed(row, { participantsCount: 0, spectatorsCount: 0, isFull: false });
		const channels = await this.listReceptionChannels(meta.guildId || null);
		const components = this.#buildComponents(eventId, { isFull: false });
		await this.#sendWithFallback(channels, { embeds: [embed], components }, meta.guildId || null);
		await this.db.query('UPDATE events SET status="running", scheduled_at=NULL WHERE id=?', [eventId]);
		return true;
	}

	async handleAnnouncementModal(interaction) {
		const title = interaction.fields.getTextInputValue('title');
		const content = interaction.fields.getTextInputValue('content');
		const eventId = Number(parseId(interaction.customId)?.parts?.[1]) || null;
		const payload = { title, content };
		const savedId = await this.saveAnnouncementDraft(payload, {
			authorId: interaction.user.id,
			guildId: interaction.guildId,
			eventId
		});
		const embed = this.buildAnnouncementEmbed(payload);
		return { embed, components: this.#buildPreviewComponents('ann', savedId), eventId: savedId };
	}

	async handleAnnouncementScheduleModal(interaction) {
		const parsed = parseId(interaction.customId);
		const eventId = Number(parsed?.parts?.[1]);
		const date = interaction.fields.getTextInputValue('date');
		const time = interaction.fields.getTextInputValue('time');
		const scheduled = this.#parseParisSchedule(date, time);
		if (!scheduled) return { error: 'invalid_date' };
		await this.markScheduled(eventId, scheduled);
		return { scheduledAt: scheduled };
	}

	async handleEventModal(interaction) {
		const title = interaction.fields.getTextInputValue('title');
		const game = interaction.fields.getTextInputValue('game');
		const description = interaction.fields.getTextInputValue('description');
		const datetime = interaction.fields.getTextInputValue('datetime');
		const maxTemp = interaction.fields.getTextInputValue('max_temp');
		const eventId = Number(parseId(interaction.customId)?.parts?.[1]) || null;

		let startsAt = null;
		if (datetime) {
			const [d, t] = datetime.split(' ');
			const parsedDate = this.#parseParisSchedule(d, t);
			if (parsedDate) startsAt = parsedDate.toISOString().slice(0, 19).replace('T', ' ');
		}
		let maxParticipants = null;
		let createTempGroup = false;
		if (maxTemp) {
			const [maxStr, tempFlag] = maxTemp.split(';');
			if (maxStr) {
				const n = Number(maxStr);
				if (!Number.isNaN(n) && n > 0) maxParticipants = n;
			}
			if ((tempFlag || '').trim().toLowerCase() === 'oui') createTempGroup = true;
		}
		const form = { title, description, game, startsAt, maxParticipants };
		const savedId = await this.saveEventDraft(form, {
			authorId: interaction.user.id,
			guildId: interaction.guildId,
			createTempGroup,
			eventId
		});
		const embed = this.buildEventEmbed(
			{
				name: title,
				description,
				game,
				starts_at: startsAt,
				max_participants: maxParticipants
			},
			{ participantsCount: 0, spectatorsCount: 0, isFull: false }
		);
		return { embed, components: this.#buildPreviewComponents('evt', savedId), eventId: savedId };
	}

	async handleEventScheduleModal(interaction) {
		const parsed = parseId(interaction.customId);
		const eventId = Number(parsed?.parts?.[1]);
		const date = interaction.fields.getTextInputValue('date');
		const time = interaction.fields.getTextInputValue('time');
		const scheduled = this.#parseParisSchedule(date, time);
		if (!scheduled) return { error: 'invalid_date' };
		await this.markScheduled(eventId, scheduled);
		return { scheduledAt: scheduled };
	}

	async handleJoinButton(interaction) {
		const parsed = parseId(interaction?.customId || '');
		const eventId = Number(parsed?.parts?.[1]);
		if (!eventId) return { error: 'not_found' };
		const eventRow = await this.getEventById(eventId);
		if (!eventRow) return { error: 'not_found' };
		let counts = await this.#getCounts(eventId);
		if (eventRow.max_participants && counts.participantsCount >= Number(eventRow.max_participants)) {
			await this.#updateEventMessage(interaction, eventRow, counts);
			return { error: 'full' };
		}
		const zoneId = await this.#resolveZoneId(eventRow, interaction);
		if (!zoneId) return { error: 'zone_missing' };
		await this.db.query(
			'INSERT INTO event_participants (event_id, user_id, zone_id, role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), zone_id = VALUES(zone_id)',
			[eventId, interaction.user.id, zoneId, 'member']
		);
		counts = await this.#getCounts(eventId);
		const isFull = await this.#updateEventMessage(interaction, eventRow, counts);
		return { status: 'joined', isFull };
	}

	async handleSpectateButton(interaction) {
		const parsed = parseId(interaction?.customId || '');
		const eventId = Number(parsed?.parts?.[1]);
		if (!eventId) return { error: 'not_found' };
		const eventRow = await this.getEventById(eventId);
		if (!eventRow) return { error: 'not_found' };
		const zoneId = await this.#resolveZoneId(eventRow, interaction);
		if (!zoneId) return { error: 'zone_missing' };
		await this.db.query(
			'INSERT INTO event_participants (event_id, user_id, zone_id, role) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), zone_id = VALUES(zone_id)',
			[eventId, interaction.user.id, zoneId, 'spectator']
		);
		const counts = await this.#getCounts(eventId);
		await this.#updateEventMessage(interaction, eventRow, counts);
		return { status: 'spectating' };
	}

	async dispatchDueAnnouncements() {
		const [rows] = await this.db.query(
			'SELECT * FROM events WHERE scheduled_at IS NOT NULL AND scheduled_at <= UTC_TIMESTAMP() AND status="draft"'
		);
		for (const row of rows || []) {
			if (row.announce_payload) {
				await this.dispatchAnnouncement(row.id);
				continue;
			}
			await this.dispatchEvent(row.id);
		}
	}
}

module.exports = { EventService };
