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
                        'INSERT INTO zone_activity (zone_id, day, msgs, reacts, voice_minutes, event_points) VALUES (?, CURRENT_DATE(), 0, 0, ?, 0) ON DUPLICATE KEY UPDATE voice_minutes = voice_minutes + VALUES(voice_minutes)',
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

                // Targets to reach “100%” (tune if needed)
                const Tm = 1000; // msgs per 14 days
                const Tv = 600; // voice minutes per 14 days

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
					ch.send(`⚠️ Faible activité détectée: ${percentage}% de l'objectif sur 14 jours. Merci de relancer la zone.`).catch(()=>{});
				}
			}
		}
	}
}

module.exports = { ActivityService };
