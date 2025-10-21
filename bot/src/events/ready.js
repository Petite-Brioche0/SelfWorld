
module.exports = {
	name: 'ready',
	once: true,
	async execute(client) {
		const { logger, services } = client.context;
		logger.info({ tag: client.user.tag }, 'Bot ready');

		await services.zone.cleanupOrphans().catch((err) => logger.error({ err }, 'cleanupOrphans failed'));

		for (const guild of client.guilds.cache.values()) {
			await services.event
				.ensureStaffPanel(guild)
				.catch((err) => logger.error({ err, guildId: guild.id }, 'ensureStaffPanel failed'));
		}

		await services.event
			.dispatchScheduledAnnouncements()
			.catch((err) => logger.error({ err }, 'Initial scheduled announcements dispatch failed'));

		// Schedule periodic tasks
		// Sweep expired temp groups hourly
		setInterval(() => {
			services.tempGroup.sweepExpired().catch((err) => logger.error({ err }, 'sweepExpired failed'));
		}, 60 * 60 * 1000);

		// Enforce freeze policy every 15 minutes
		setInterval(() => {
			services.tempGroup.enforceFreezePolicy(72).catch((err) =>
				logger.error({ err }, 'enforceFreezePolicy failed')
			);
			services.tempGroup.cleanupFreezeVotes().catch((err) =>
				logger.error({ err }, 'cleanupFreezeVotes failed')
			);
		}, 15 * 60 * 1000);

		setInterval(() => {
			services.event
				.dispatchScheduledAnnouncements()
				.catch((err) => logger.error({ err }, 'Scheduled announcements dispatch failed'));
		}, 60 * 1000);

		// Post low-activity alerts daily
		setInterval(() => {
			services.activity
				.postLowActivityAlerts()
				.catch((err) => logger.error({ err }, 'activity alerts failed'));
		}, 24 * 60 * 60 * 1000);

		client.user.setPresence({
			activities: [{ name: 'secure zone ops' }],
			status: 'online'
		});
	}
};
