
const crypto = require('crypto');
const { WebhookClient, EmbedBuilder } = require('discord.js');

class AnonService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
	}

	#todaySalt() {
		const d = new Date();
		const key = `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
		return crypto.createHash('sha256').update('daily-salt::' + key).digest('hex').slice(0, 16);
	}

	#anonName(userId, targetZoneId) {
		const seed = `${userId}:${targetZoneId}:${this.#todaySalt()}`;
		const h = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 6);
		return `Anonyme-${h}`;
	}

	async #getAnonAdminChannelId(guildId) {
		const [rows] = await this.db.query('SELECT anon_admin_channel_id FROM settings WHERE guild_id = ?', [guildId]);
		return rows?.[0]?.anon_admin_channel_id || process.env.ANON_ADMIN_CHANNEL_ID || null;
	}

	async #findZoneByAnonChannel(channelId) {
		const [rows] = await this.db.query('SELECT zone_id FROM anon_channels WHERE source_channel_id = ?', [channelId]);
		return rows?.[0]?.zone_id || null;
	}

	async #targetsExcept(zoneId) {
		const [rows] = await this.db.query('SELECT zone_id, source_channel_id, webhook_id, webhook_token FROM anon_channels WHERE zone_id <> ?', [zoneId]);
		return rows;
	}

	async #ensureWebhook(row) {
		if (row.webhook_id && row.webhook_token) return row;
		const channel = await this.client.channels.fetch(row.source_channel_id).catch(()=>null);
		if (!channel) return row;
		const hook = await channel.createWebhook({ name: 'Anon Relay' });
		await this.db.query('UPDATE anon_channels SET webhook_id=?, webhook_token=? WHERE zone_id=?', [hook.id, hook.token, row.zone_id]);
		row.webhook_id = hook.id;
		row.webhook_token = hook.token;
		return row;
	}

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

		// Log raw to admin
		const adminChannelId = await this.#getAnonAdminChannelId(message.guild.id);
		if (adminChannelId) {
			const adminCh = await this.client.channels.fetch(adminChannelId).catch(()=>null);
			if (adminCh) {
				const e = new EmbedBuilder()
					.setTitle('Anon log (raw)')
					.setDescription(this.#sanitize(message.content || '(no text)'))
					.addFields(
						{ name: 'Author', value: `${message.author.tag} (${message.author.id})` },
						{ name: 'From Zone', value: String(zoneId) },
						{ name: 'Channel', value: `<#${message.channelId}>` },
					)
					.setTimestamp();
				adminCh.send({ embeds: [e] }).catch(()=>{});
			}
		}

		// Delete original
		await message.delete().catch(()=>{});

		// Fan-out
		const targets = await this.#targetsExcept(zoneId);
		const files = message.attachments?.size ? [...message.attachments.values()].map(a => a.url) : [];

		for (const row of targets) {
			const hooked = await this.#ensureWebhook(row);
			if (!hooked.webhook_id || !hooked.webhook_token) continue;

			const hook = new WebhookClient({ id: hooked.webhook_id, token: hooked.webhook_token });
			const name = this.#anonName(message.author.id, row.zone_id);
			const content = this.#sanitize(message.content || '');

			await hook.send({
				username: name,
				content: content.length ? content : undefined,
				files,
				allowedMentions: { parse: [] }
			}).catch(()=>{});
		}
	}
}

module.exports = { AnonService };
