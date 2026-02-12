// Ensures that each member has the same anonymous username across all channels (when a user sends messages in two different zones, they keep their anonymous name in each zone)

// Anonymous channel system: detects messages, deletes them, then resends the message with a random name through the anon channel of each zone, and logs them
const crypto = require('crypto');
const { WebhookClient, EmbedBuilder } = require('discord.js');
const { generateAnonName } = require('../utils/anonNames');

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
		} catch { /* ignored */ }
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
				await this.db.query('UPDATE anon_channels SET webhook_id=?, webhook_token=? WHERE zone_id=?', ['0', '0', row.zone_id]).catch(() => {
					// Expected failure if table doesn't exist - intentionally silent
				});
				row.webhook_id = '0';
				row.webhook_token = '0';
				row._webhookDisabled = true;
			} else {
				this.logger?.error?.({ err, channelId: row.source_channel_id }, 'Failed to ensure anon webhook');
			}
		}

		return row;
	}

	// Sanitizes @everyone and @here mentions even if the user is not allowed to mention them
	#sanitize(content) {
		if (!content) return '';
		return content
			.replace(/@everyone/gi, '@\u200beveryone')
			.replace(/@here/gi, '@\u200bhere');
	}

	async handleMessage(message) {
		if (!message || !message.guild || message.author.bot) return;

		const zoneId = await this.#findZoneByAnonChannel(message.channelId);
		if (!zoneId) return; // not an anon channel

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
		).catch((err) => {
			this.logger?.warn({ err, zoneId }, 'Failed to log anonymous message');
		});

		// Log raw to admin
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
						{ name: 'Auteur', value: `${message.author.tag} (${message.author.id})` },
					)
					.setTimestamp(message.createdAt || new Date());
				if (files.length) {
					embed.addFields({ name: 'Pièces jointes', value: `${files.length}` });
				}
				await adminCh.send({ content: logContent, allowedMentions: { parse: [] } }).catch((err) => { this.logger?.debug?.({ err }, 'Failed to send anon admin log'); });
				await adminCh.send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch((err) => { this.logger?.debug?.({ err }, 'Failed to send anon admin log'); });
			}
		}

		// Delete original
		await message.delete().catch((err) => { if (err?.code !== 10008) this.logger?.debug?.({ err }, 'Failed to delete original anon message'); });

		// Relay only to the source zone's anon channel (not all zones)
		const targets = await this.#allTargets();

		for (const row of targets) {
			if (!row || !row.source_channel_id) continue;
			// Only relay to the zone the message originated from
			if (String(row.zone_id) !== String(zoneId)) continue;
			const hooked = await this.#ensureWebhook(row);
			if (!hooked || hooked._webhookDisabled) continue;
			if (!hooked.webhook_id || !hooked.webhook_token) continue;

			const hook = new WebhookClient({ id: hooked.webhook_id, token: hooked.webhook_token });
			const name = this.#buildAnonName(message.author.id, row.zone_id);

			try {
				await hook.send({
					username: name,
					content: sanitized.length ? sanitized : undefined,
					files,
					allowedMentions: { parse: [] }
				});
			} catch (err) {
				this.logger?.warn?.({ err, zoneId: row.zone_id }, 'Failed to relay anonymous message');
			} finally {
				hook.destroy();
			}
		}
	}
}

module.exports = { AnonService };
