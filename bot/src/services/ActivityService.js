// Activity system for zones, tracking messages, reactions, voice chat minutes, and event points for each day
class ActivityService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
	}

	async addMessage(zoneId) {
		await this.db.query(
			'INSERT INTO zone_activity (zone_id, day, msgs, reacts, voice_minutes, event_points) VALUES (?, CURRENT_DATE(), 1, 0, 0, 0) ON DUPLICATE KEY UPDATE msgs = msgs + 1',
			[zoneId]
		);
	}

	async addReaction(zoneId) {
		await this.db.query(
			'INSERT INTO zone_activity (zone_id, day, msgs, reacts, voice_minutes, event_points) VALUES (?, CURRENT_DATE(), 0, 1, 0, 0) ON DUPLICATE KEY UPDATE reacts = reacts + 1',
			[zoneId]
		);
	}

        async addVoice(zoneId, minutes) {
                await this.db.query(
                        'INSERT INTO zone_activity (zone_id, day, msgs, reacts, voice_minutes, event_points) VALUES (?, CURRENT_DATE(), 0, 0, ?, 0) AS new ON DUPLICATE KEY UPDATE voice_minutes = voice_minutes + new.voice_minutes',
                        [zoneId, minutes]
                );
        }

        /**
         * Compute normalized activity score in [0,1] over a rolling window.
         * Heuristic: msgs (60%), voice minutes (40%), clamped to max targets.
         */
        async getZoneActivityScore(zoneId, days = 14) {
                const [rows] = await this.db.query(
                        `SELECT
       COALESCE(SUM(msgs),0) AS msgs,
       COALESCE(SUM(voice_minutes),0) AS voice
     FROM zone_activity
     WHERE zone_id = ? AND day >= DATE_SUB(CURRENT_DATE(), INTERVAL ? DAY)`,
                        [zoneId, days]
                );
                const m = Number(rows?.[0]?.msgs || 0);
                const v = Number(rows?.[0]?.voice || 0);

                const Tm = Number(process.env.ACTIVITY_TARGET_MSGS) || 1000;
                const Tv = Number(process.env.ACTIVITY_TARGET_VOICE) || 600;

                const sm = Math.min(1, m / Tm);
                const sv = Math.min(1, v / Tv);

                const score = 0.6 * sm + 0.4 * sv;
                return Math.max(0, Math.min(1, score));
        }

        /** Build a unicode progress bar like ▰▰▰▱▱ (10 segments) */
        buildProgressBar(score) {
                const total = 10;
                const filled = Math.round(score * total);
                return '▰'.repeat(filled) + '▱'.repeat(total - filled);
        }

	/** Post low-activity alerts directly in #reception when activity falls below 10% of target */
	async postLowActivityAlerts() {
		const [zones] = await this.db.query('SELECT id, text_reception_id FROM zones');
		for (const z of zones) {
			const score = await this.getZoneActivityScore(z.id, 14);
			if (score < 0.1) { // Below 10% of target activity
				const ch = await this.client.channels.fetch(z.text_reception_id).catch(()=>null);
				if (ch) {
					const percentage = Math.round(score * 100);
					ch.send(`⚠️ Faible activité détectée: ${percentage}% de l'objectif sur 14 jours. Merci de relancer la zone.`).catch((err) => { console.debug('Failed to send low activity alert', { err, zoneId: z.id }); });
				}
			}
		}
	}

	/**
	 * Handle inactivity alert button interactions (zone:inactive:*)
	 * @param {import('discord.js').ButtonInteraction} interaction
	 * @param {Object} options
	 * @param {Object} options.zoneService
	 * @param {string} options.ownerUserId
	 */
	async handleInactivityButton(interaction, { zoneService, ownerUserId } = {}) {
		const { MessageFlags, EmbedBuilder } = require('discord.js');
		const customId = interaction.customId || '';
		const parts = customId.split(':');
		// Expected format: zone:inactive:<action>:<zoneId>
		const action = parts[2];
		const zoneId = parts[3];

		if (!zoneId) {
			await interaction.reply({ content: '❌ Zone introuvable.', flags: MessageFlags.Ephemeral });
			return;
		}

		if (action === 'check') {
			const score = await this.getZoneActivityScore(zoneId, 14);
			const percentage = Math.round(score * 100);
			const bar = this.buildProgressBar(score);
			const embed = new EmbedBuilder()
				.setColor(score < 0.1 ? 0xed4245 : score < 0.5 ? 0xfee75c : 0x57f287)
				.setTitle('Activité de la zone')
				.setDescription(`${bar} **${percentage}%** de l'objectif sur 14 jours`)
				.setTimestamp();
			await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
			return;
		}

		if (action === 'delete') {
			if (!ownerUserId || interaction.user.id !== String(ownerUserId)) {
				await interaction.reply({ content: '🔒 Seul le propriétaire du bot peut supprimer une zone.', flags: MessageFlags.Ephemeral });
				return;
			}
			if (zoneService?.deleteZone) {
				await interaction.deferReply({ flags: MessageFlags.Ephemeral });
				await zoneService.deleteZone(zoneId, interaction.guild.id);
				await interaction.editReply({ content: `✅ Zone #${zoneId} supprimée.` });
			} else {
				await interaction.reply({ content: '❌ Service de zone indisponible.', flags: MessageFlags.Ephemeral });
			}
			return;
		}

		await interaction.reply({ content: '❌ Action inconnue.', flags: MessageFlags.Ephemeral });
	}
}

module.exports = { ActivityService };
