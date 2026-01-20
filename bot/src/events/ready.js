
module.exports = {
	name: 'clientReady',
	once: true,
	async execute(client) {
		const { logger, services } = client.context;
		logger.info({ tag: client.user.tag }, 'Bot ready');

		await services.zone.cleanupOrphans().catch(err => logger.error({ err }, 'cleanupOrphans failed'));
		await services.staffPanel?.ensureStaffPanels?.().catch(err => logger.error({ err }, 'staff panel setup failed'));
		await services.staffPanel?.processScheduled?.().catch(err => logger.error({ err }, 'scheduled tasks failed'));

		// Schedule periodic tasks
		// Sweep expired temp groups hourly
		setInterval(() => {
			services.tempGroup.sweepExpired().catch(err => logger.error({ err }, 'sweepExpired failed'));
		}, 60 * 60 * 1000);

		// Post low-activity alerts daily
		setInterval(() => {
			services.activity.postLowActivityAlerts().catch(err => logger.error({ err }, 'activity alerts failed'));
		}, 24 * 60 * 60 * 1000);

		// Process scheduled staff announcements/events every minute
		setInterval(() => {
			services.staffPanel?.processScheduled?.().catch(err => logger.error({ err }, 'scheduled tasks failed'));
		}, 60 * 1000);

		client.user.setPresence({
			activities: [{ name: 'secure zone ops' }],
			status: 'online'
		});
	}
};
