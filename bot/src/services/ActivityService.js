class ActivityService {
	constructor(client, pool, zoneService, logger) {
		this.client = client;
		this.pool = pool;
		this.zoneService = zoneService;
		this.logger = logger;
		this.buffer = new Map();
	}

	start() {
		setInterval(() => this.flush().catch((error) => this.logger.error({ err: error }, 'Activity flush failed')), 5 * 60 * 1000).unref();
	}

	recordMessage(zoneId) {
		this.increment(zoneId, 'msgs');
	}

	recordReaction(zoneId) {
		this.increment(zoneId, 'reacts');
	}

	recordVoice(zoneId, minutes) {
		this.increment(zoneId, 'voice_minutes', minutes);
	}

	recordEventPoint(zoneId, points = 1) {
		this.increment(zoneId, 'event_points', points);
	}

	increment(zoneId, key, value = 1) {
		if (!this.buffer.has(zoneId)) {
			this.buffer.set(zoneId, { msgs: 0, reacts: 0, voice_minutes: 0, event_points: 0 });
		}
		const entry = this.buffer.get(zoneId);
		entry[key] += value;
	}

	async flush() {
		const entries = Array.from(this.buffer.entries());
		if (!entries.length) {
			return;
		}
		this.buffer.clear();
		for (const [zoneId, stats] of entries) {
			await this.pool.query(
				`INSERT INTO zone_activity (zone_id, day, msgs, reacts, voice_minutes, event_points)
				VALUES (?, CURRENT_DATE(), ?, ?, ?, ?)
				ON DUPLICATE KEY UPDATE msgs = msgs + VALUES(msgs), reacts = reacts + VALUES(reacts), voice_minutes = voice_minutes + VALUES(voice_minutes), event_points = event_points + VALUES(event_points)`,
				[zoneId, stats.msgs, stats.reacts, stats.voice_minutes, stats.event_points]
			);
		}
	}
}

module.exports = ActivityService;