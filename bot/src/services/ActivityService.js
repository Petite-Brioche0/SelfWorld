
class ActivityService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
	}

	async addMessage(zoneId) {
		await this.db.query('INSERT INTO zone_activity (zone_id, day, msgs, reacts, voice_minutes, event_points) VALUES (?, CURRENT_DATE(), 1, 0, 0, 0) ON DUPLICATE KEY UPDATE msgs = msgs + 1', [zoneId]);
	}

	async addReaction(zoneId) {
		await this.db.query('INSERT INTO zone_activity (zone_id, day, msgs, reacts, voice_minutes, event_points) VALUES (?, CURRENT_DATE(), 0, 1, 0, 0) ON DUPLICATE KEY UPDATE reacts = reacts + 1', [zoneId]);
	}

	async addVoice(zoneId, minutes) {
		await this.db.query('INSERT INTO zone_activity (zone_id, day, msgs, reacts, voice_minutes, event_points) VALUES (?, CURRENT_DATE(), 0, 0, ?, 0) ON DUPLICATE KEY UPDATE voice_minutes = voice_minutes + VALUES(voice_minutes)', [zoneId, minutes]);
	}

	/** Post low-activity alert directly in #reception (thresholds are simplistic here) */
	async postLowActivityAlerts() {
		// Example threshold: no msgs in last 14 days
		const [zones] = await this.db.query('SELECT id, text_reception_id FROM zones');
		for (const z of zones) {
			const [rows] = await this.db.query('SELECT SUM(msgs) AS s FROM zone_activity WHERE zone_id=? AND day >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)', [z.id]);
			const s = rows?.[0]?.s || 0;
			if (s === 0) {
				const ch = await this.client.channels.fetch(z.text_reception_id).catch(()=>null);
				if (ch) ch.send('⚠️ Faible activité détectée (14 jours). Merci de relancer la zone.').catch(()=>{});
			}
		}
	}
}

module.exports = { ActivityService };
