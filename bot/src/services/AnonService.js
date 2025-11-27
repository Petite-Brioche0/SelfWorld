
const crypto = require('crypto');
const {
WebhookClient,
EmbedBuilder,
MessageFlags,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle
} = require('discord.js');
const { generateAnonName } = require('../utils/anonNames');
const { ensureFallback } = require('../utils/channels');
const { makeId } = require('../utils/ids');

class AnonService {
	constructor(client, db, logger = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
	}

	#todaySalt() {
		const d = new Date();
		const key = `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
		return crypto.createHash('sha256').update('daily-salt::' + key).digest('hex').slice(0, 16);
	}

	#buildAnonName(userId, targetZoneId) {
	const seed = `${userId}:${targetZoneId}:${this.#todaySalt()}`;
	return generateAnonName(seed);
	}

	async #getZone(zoneId) {
	const [rows] = await this.db.query(
	'SELECT id, name, guild_id, role_owner_id, role_member_id FROM zones WHERE id = ?',
	[zoneId]
	);
	return rows?.[0] || null;
	}

	async #resolveZoneColor(zoneRow) {
	if (!zoneRow) return 0x5865f2;
	try {
	const guild = await this.client.guilds.fetch(zoneRow.guild_id);
	if (zoneRow.role_owner_id) {
	const ownerRole = await guild.roles.fetch(zoneRow.role_owner_id).catch(() => null);
	if (ownerRole?.color) return ownerRole.color;
	}
	if (zoneRow.role_member_id) {
	const memberRole = await guild.roles.fetch(zoneRow.role_member_id).catch(() => null);
	if (memberRole?.color) return memberRole.color;
	}
	} catch {}
	return 0x5865f2;
	}

	async #getAnonAdminChannelId(guildId) {
		const [rows] = await this.db.query('SELECT anon_admin_channel_id FROM settings WHERE guild_id = ?', [guildId]);
		return rows?.[0]?.anon_admin_channel_id || process.env.ANON_ADMIN_CHANNEL_ID || null;
	}

	async #findZoneByAnonChannel(channelId) {
		const [rows] = await this.db.query('SELECT zone_id FROM anon_channels WHERE source_channel_id = ?', [channelId]);
		return rows?.[0]?.zone_id || null;
	}

	async #allTargets() {
		const [rows] = await this.db.query('SELECT zone_id, source_channel_id, webhook_id, webhook_token FROM anon_channels');
		return rows;
	}

	async #ensureWebhook(row) {
		if (!row) return row;
		if (row.webhook_id === '0' || row.webhook_token === '0') {
			row._webhookDisabled = true;
			return row;
		}
		if (row.webhook_id && row.webhook_token) return row;

		const channel = await this.client.channels.fetch(row.source_channel_id).catch(() => null);
		if (!channel) return row;

		try {
			const hook = await channel.createWebhook({ name: 'Anon Relay' });
			await this.db.query('UPDATE anon_channels SET webhook_id=?, webhook_token=? WHERE zone_id=?', [hook.id, hook.token, row.zone_id]);
			row.webhook_id = hook.id;
			row.webhook_token = hook.token;
		} catch (err) {
			if (err?.code === 50013 || err?.status === 403) {
				this.logger?.warn?.({ err, channelId: row.source_channel_id }, 'Missing Manage Webhooks permission');
				await this.db.query('UPDATE anon_channels SET webhook_id=?, webhook_token=? WHERE zone_id=?', ['0', '0', row.zone_id]).catch(() => {});
				row.webhook_id = '0';
				row.webhook_token = '0';
				row._webhookDisabled = true;
			} else {
				this.logger?.error?.({ err, channelId: row.source_channel_id }, 'Failed to ensure anon webhook');
			}
		}

		return row;
	}

#sanitize(content) {
if (!content) return '';
return content
.replace(/@everyone/gi, '@\u200beveryone')
.replace(/@here/gi, '@\u200bhere');
}

async handleCreateClosed(interaction, tempGroupService) {
if (!interaction?.guild || !interaction?.user) {
throw new Error('interaction incomplete');
}
if (!tempGroupService?.createTempGroup) {
throw new Error('temp group service unavailable');
}
const created = await tempGroupService.createTempGroup(interaction.guild, {
name: 'Groupe anonyme',
isOpen: false,
participants: [interaction.user.id],
authorId: interaction.user.id,
requester: interaction.user
});
let delivered = false;
try {
await interaction.user.send({ content: `Salon privé : <#${created.textChannelId}>`, flags: MessageFlags.SuppressNotifications });
delivered = true;
} catch (err) {
this.logger?.warn?.({ err, userId: interaction.user.id }, 'Failed to DM anon invite');
}
if (!delivered) {
const fallback = await ensureFallback(interaction.guild, 'requests').catch(() => null);
if (fallback) {
await fallback
.send({ content: 'Invitation anonyme non délivrée (DM fermé).', allowedMentions: { parse: [] } })
.catch(() => {});
}
}
return created;
}

async handleCreateOpen(interaction, tempGroupService) {
if (!interaction?.guild || !interaction?.user) {
throw new Error('interaction incomplete');
}
if (!tempGroupService?.createTempGroup) {
throw new Error('temp group service unavailable');
}
const created = await tempGroupService.createTempGroup(interaction.guild, {
name: 'Groupe anonyme ouvert',
isOpen: true,
participants: [interaction.user.id],
authorId: interaction.user.id,
requester: interaction.user
});
const row = new ActionRowBuilder().addComponents(
new ButtonBuilder().setCustomId(makeId('temp', 'join', created.id)).setLabel('Rejoindre').setStyle(ButtonStyle.Success),
new ButtonBuilder()
.setCustomId(makeId('temp', 'spectate', created.id))
.setLabel('Observer')
.setStyle(ButtonStyle.Secondary),
new ButtonBuilder().setCustomId(makeId('temp', 'leave', created.id)).setLabel('Quitter').setStyle(ButtonStyle.Danger)
);
const embed = new EmbedBuilder()
.setTitle('Groupe temporaire anonyme')
.setDescription('Rejoignez ce groupe pour continuer en privé.')
.setColor(0x5865f2);
if (interaction.channel) {
await interaction.channel.send({ embeds: [embed], components: [row] }).catch(() => {});
}
return created;
}

	async handleMessage(message) {
		if (!message || !message.guild || message.author.bot) return;

		const zoneId = await this.#findZoneByAnonChannel(message.channelId);
		if (!zoneId) return false; // not an anon channel

		const zoneRow = await this.#getZone(zoneId);
		const zoneColor = await this.#resolveZoneColor(zoneRow);
		const sanitized = this.#sanitize(message.content || '');
		const logContent = sanitized || '(aucun texte)';
		const files = message.attachments?.size
			? [...message.attachments.values()].map((a) => a.url)
			: [];

		await this.db.query(
			'INSERT INTO anon_logs (guild_id, source_zone_id, author_id, content, created_at) VALUES (?, ?, ?, ?, NOW())',
			[message.guild.id, zoneId, message.author.id, sanitized]
		).catch(() => {});

		const adminChannelId = await this.#getAnonAdminChannelId(message.guild.id);
		if (adminChannelId) {
			const adminCh = await this.client.channels.fetch(adminChannelId).catch(() => null);
			if (adminCh) {
				const embed = new EmbedBuilder()
					.setTitle('Anon log')
					.setColor(zoneColor)
					.setThumbnail(message.author.displayAvatarURL({ size: 128 }))
					.addFields(
						{ name: 'Zone', value: zoneRow ? `${zoneRow.name} (#${zoneRow.id})` : `Zone ${zoneId}` },
						{ name: 'Auteur', value: `${message.author.tag} (${message.author.id})` }
					)
					.setTimestamp(message.createdAt || new Date());

				if (files.length) {
					embed.addFields({ name: 'Pièces jointes', value: `${files.length}` });
				}

				await adminCh.send({ content: logContent, allowedMentions: { parse: [] } }).catch(() => {});
				await adminCh.send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch(() => {});
			}
		}

		await message.delete().catch(() => {});

		const targets = await this.#allTargets();

		for (const row of targets) {
			if (!row || !row.source_channel_id) continue;
			const hooked = await this.#ensureWebhook(row);
			if (!hooked || hooked._webhookDisabled) continue;
			if (!hooked.webhook_id || !hooked.webhook_token) continue;

			const hook = new WebhookClient({ id: hooked.webhook_id, token: hooked.webhook_token });
			const name = this.#buildAnonName(message.author.id, row.zone_id);

			await hook.send({
				username: name,
				content: sanitized.length ? sanitized : undefined,
				files,
				allowedMentions: { parse: [] }
			}).catch((err) => {
				this.logger?.warn?.({ err, zoneId: row.zone_id }, 'Failed to relay anonymous message');
			});
		}

		return true;
	}
	async bumpAnonChannelCounter({ guildId, channelId, now = new Date() }) {
		if (!guildId || !channelId) {
			return { notify: false };
		}

		const baseDate = Number.isNaN(new Date(now).getTime()) ? new Date() : new Date(now);
		const isoDay = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate()))
			.toISOString()
			.slice(0, 10);

		const connection = await this.db.getConnection();
		try {
			await connection.beginTransaction();
			await connection.query(
				'INSERT INTO anon_channel_daily_counts (guild_id, channel_id, day, count, next_target) VALUES (?, ?, ?, 0, 10) ON DUPLICATE KEY UPDATE count = count',
				[guildId, channelId, isoDay]
			);

			const [rows] = await connection.query(
				'SELECT count, next_target FROM anon_channel_daily_counts WHERE guild_id = ? AND channel_id = ? AND day = ? FOR UPDATE',
				[guildId, channelId, isoDay]
			);
			if (!rows || !rows.length) {
				await connection.commit();
				return { notify: false };
			}

			const current = rows[0];
			const newCount = current.count + 1;
			let nextTarget = current.next_target;
			let notify = false;
			if (newCount >= current.next_target) {
				notify = true;
				nextTarget = current.next_target + 100;
			}

			await connection.query(
				'UPDATE anon_channel_daily_counts SET count = ?, next_target = ? WHERE guild_id = ? AND channel_id = ? AND day = ?',
				[newCount, nextTarget, guildId, channelId, isoDay]
			);

			await connection.commit();
			return notify ? { notify: true, count: newCount, nextTarget } : { notify: false };
		} catch (error) {
			await connection.rollback();
			throw error;
		} finally {
			connection.release();
		}
	}

	async presentOptions(interaction, { message = null } = {}) {
		const baseText = [
			'📣 Les messages envoyés dans ce salon sont relayés anonymement aux zones participantes.',
			'🚨 Les abus sont consignés et peuvent entraîner des sanctions.'
		];

		if (message?.url) {
			baseText.push(`Message ciblé : ${message.url}`);
		}

		const payload = {
			content: baseText.join('\n'),
			flags: MessageFlags.Ephemeral
		};

		if (interaction.deferred || interaction.replied) {
			return interaction.followUp(payload);
		}

		return interaction.reply(payload);
	}
}

module.exports = { AnonService };
