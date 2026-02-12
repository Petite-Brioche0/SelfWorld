// Handles bot ready event and initializes periodic tasks
const { TaskScheduler } = require('../utils/TaskScheduler');

module.exports = {
	name: 'clientReady',
	once: true,
	async execute(client) {
		const { logger, services } = client.context;
		logger.info({ tag: client.user.tag }, 'Bot ready');

		await services.zone.cleanupOrphans().catch(err => logger.error({ err }, 'cleanupOrphans failed'));
		await services.staffPanel?.ensureStaffPanels?.().catch(err => logger.error({ err }, 'staff panel setup failed'));
		await services.staffPanel?.processScheduled?.().catch(err => logger.error({ err }, 'scheduled tasks failed'));
		await services.hub?.ensureAllHubChannels?.().catch(err => logger.error({ err }, 'hub setup failed'));

		// Initialize task scheduler for periodic tasks
		const scheduler = new TaskScheduler(logger);

		// Schedule: Sweep expired temp groups hourly (with 5 min timeout)
		scheduler.schedule('sweep-expired-groups', 60 * 60 * 1000, async () => {
			await services.tempGroup.sweepExpired();
		}, { timeout: 5 * 60 * 1000 });

		// Schedule: Post low-activity alerts daily (with 10 min timeout)
		scheduler.schedule('low-activity-alerts', 24 * 60 * 60 * 1000, async () => {
			await services.activity.postLowActivityAlerts();
		}, { timeout: 10 * 60 * 1000 });

		// Schedule: Process scheduled staff announcements/events every minute (with 2 min timeout)
		scheduler.schedule('process-scheduled-tasks', 60 * 1000, async () => {
			await services.staffPanel?.processScheduled?.();
		}, { timeout: 2 * 60 * 1000 });

		// Store scheduler in client context for graceful shutdown
		client.context.scheduler = scheduler;

		client.user.setPresence({
			activities: [{ name: 'secure zone ops' }],
			status: 'online'
		});
	}
};
