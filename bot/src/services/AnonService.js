const { WebhookClient, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const { pseudonym, hashToBase64 } = require('../utils/ids');

class AnonService {
	constructor(client, pool, zoneService, activityService, logger) {
		this.client = client;
		this.pool = pool;
		this.zoneService = zoneService;
		this.activityService = activityService;
		this.logger = logger;
		this.salt = hashToBase64(`${Date.now()}`);
		this.cooldown = new Map();
	}

	loadSaltScheduler() {
		setInterval(() => {
			this.salt = hashToBase64(`${Date.now()}`);
			this.logger.info('Anon salt rotated');
		}, 24 * 60 * 60 * 1000).unref();
	}

	getDailySalt() {
		return this.salt;
	}

	async handleMessage(message) {
		const zone = await this.zoneService.getZoneByChannelId(message.channel.id);
		if (!zone || zone.text_anon_id !== message.channel.id) {
			return;
		}
		if (!message.deletable) {
			throw new Error('Impossible de supprimer le message initial pour anonymisation.');
		}
		const rawContent = message.content;
		const sanitized = message.cleanContent.replace(/@(everyone|here)/gu, '').trim();
		await message.delete().catch(() => undefined);
		const salt = this.getDailySalt();
		const alias = pseudonym(message.author.id, zone.id, salt);
		const payload = sanitized || '*Message sans texte*';

		await this.pool.query('INSERT INTO anon_logs (guild_id, source_zone_id, author_id, content) VALUES (?, ?, ?, ?)', [message.guild.id, zone.id, message.author.id, rawContent]);
		await this.forwardToAdmin(zone.guild_id, alias, rawContent, message.attachments);
		await this.broadcastToZones(zone, alias, payload);
		this.activityService.recordMessage(zone.id);
	}

	async broadcastToZones(sourceZone, alias, content) {
		const [rows] = await this.pool.query('SELECT z.id, a.webhook_id, a.webhook_token FROM zones z JOIN anon_channels a ON a.zone_id = z.id WHERE z.guild_id = ?', [sourceZone.guild_id]);
		for (const row of rows) {
			if (row.id === sourceZone.id) {
				continue;
			}
			if (!row.webhook_id || !row.webhook_token) {
				continue;
			}
			const webhook = new WebhookClient({ id: row.webhook_id, token: row.webhook_token });
			await webhook.send({
				username: alias,
				content,
				allowedMentions: { parse: [] }
			}).catch((error) => this.logger.error({ err: error }, 'Failed to relay anonymous message'));
		}
	}

	async forwardToAdmin(guildId, alias, rawContent, attachments) {
		const settings = await this.zoneService.getSettings(guildId);
		if (!settings?.anon_admin_channel_id) {
			return;
		}
		const channel = await this.client.channels.fetch(settings.anon_admin_channel_id);
		if (!channel) {
			return;
		}
		const embed = new EmbedBuilder()
		.setTitle('Log anonyme brut')
		.setDescription(rawContent || '*Sans contenu*')
		.addFields({ name: 'Alias', value: alias })
		.setTimestamp();
		await channel.send({ embeds: [embed], files: [...attachments.values()].slice(0, 3) });
	}

	async setLogChannel(guildId, channelId) {
		await this.pool.query('UPDATE settings SET anon_admin_channel_id = ? WHERE guild_id = ?', [channelId, guildId]);
	}

	async presentOptions(interaction, meta = {}) {
		const components = new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId('temp:request').setLabel('👥 Groupe temporaire').setStyle(ButtonStyle.Primary),
			new ButtonBuilder().setCustomId('zone:invite').setLabel('➕ Inviter à ma zone').setStyle(ButtonStyle.Secondary)
		);
		const content = meta.message ? 'Options anonymes pour le message ciblé.' : 'Options anonymes disponibles :';
		await interaction.reply({
			content,
			components: [components],
			ephemeral: true
		});
	}
}

module.exports = AnonService;