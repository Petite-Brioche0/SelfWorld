const {
ActionRowBuilder,
ButtonBuilder,
ButtonStyle,
EmbedBuilder
} = require('discord.js');
const { ensureFallback } = require('../utils/channels');

class EventService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
	}

	buildAnnouncementEmbed(payload) {
const embed = new EmbedBuilder().setTitle(payload?.title || 'Announcement');
		if (payload?.content) {
			embed.setDescription(payload.content);
		}
		return embed;
	}

	buildEventEmbed(eventRow, { participantsCount = 0, spectatorsCount = 0, isFull = false } = {}) {
const embed = new EmbedBuilder().setTitle(eventRow?.name || 'Event');
if (eventRow?.game) {
embed.addFields({ name: 'Game', value: eventRow.game, inline: true });
}
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
if (eventRow?.description) {
embed.setDescription(eventRow.description);
}
embed.addFields({ name: 'Participants', value: `${participantsCount}`, inline: true });
embed.addFields({ name: 'Spectators', value: `${spectatorsCount}`, inline: true });
if (isFull) {
embed.setFooter({ text: 'Full' });
}
		return embed;
	}

async saveAnnouncementDraft(payload, { authorId, guildId, scheduledAt = null, eventId = null } = {}) {
const jsonPayload = JSON.stringify({ title: payload?.title || 'Annonce', content: payload?.content || '', guildId });
if (eventId) {
await this.db.query(
'UPDATE events SET name=?, description=?, author_id=?, scheduled_at=?, announce_payload=? WHERE id=?',
[payload?.title || 'Annonce', payload?.content || '', authorId || null, scheduledAt, jsonPayload, eventId]
);
			return eventId;
		}
const [res] = await this.db.query(
'INSERT INTO events (name, status, description, author_id, scheduled_at, announce_payload, starts_at, ends_at, max_participants, temp_group_id) VALUES (?, "draft", ?, ?, ?, ?, NULL, NULL, NULL, NULL)',
[payload?.title || 'Annonce', payload?.content || '', authorId || null, scheduledAt, jsonPayload]
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

		if (eventId) {
await this.db.query(
'UPDATE events SET name=?, description=?, author_id=?, scheduled_at=?, game=?, starts_at=?, ends_at=?, max_participants=?, temp_group_id=?, announce_payload=? WHERE id=?',
[
form?.title || 'Événement',
description,
authorId || null,
scheduledAt,
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
form?.title || 'Événement',
description,
authorId || null,
scheduledAt,
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
		await this.db.query('UPDATE events SET scheduled_at=? WHERE id=?', [scheduledAtUTC, eventId]);
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
if (ch) {
channels.push(ch);
}
}
}
if (!channels.length) {
const guild = targetGuildId ? await this.client.guilds.fetch(String(targetGuildId)).catch(() => null) : null;
			if (guild) {
				const fallback = await ensureFallback(guild, 'events-admin').catch(() => null);
				if (fallback) {
					channels.push(fallback);
				}
			}
		}
		return channels;
	}

async dispatchAnnouncement(eventId) {
const row = await this.getEventById(eventId);
if (!row) return false;
const payload = row.announce_payload ? JSON.parse(row.announce_payload) : { title: row.name, content: row.description };
const embed = this.buildAnnouncementEmbed(payload);
const channels = await this.listReceptionChannels(payload.guildId || null);
		for (const ch of channels) {
			await ch.send({ embeds: [embed] }).catch(() => {});
		}
		await this.db.query('UPDATE events SET status="running", scheduled_at=NULL WHERE id=?', [eventId]);
		return true;
	}

async dispatchEvent(eventId) {
const row = await this.getEventById(eventId);
if (!row) return false;
const meta = row.announce_payload ? JSON.parse(row.announce_payload) : {};
const embed = this.buildEventEmbed(row, { participantsCount: 0, spectatorsCount: 0, isFull: false });
		const joinButton = new ButtonBuilder()
				.setCustomId(`event:join:${eventId}:0`)
				.setStyle(ButtonStyle.Primary)
				.setLabel('Join');
		const channels = await this.listReceptionChannels(meta.guildId || null);
		for (const ch of channels) {
			await ch
				.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(joinButton)] })
				.catch(() => {});
		}
		await this.db.query('UPDATE events SET status="running", scheduled_at=NULL WHERE id=?', [eventId]);
		return true;
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
