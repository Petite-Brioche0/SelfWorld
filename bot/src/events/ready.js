module.exports = {
	name: 'ready',
	once: true,
	async execute(client) {
		const { logger, services } = client.context;
		logger.info({ tag: client.user.tag }, 'Bot ready');
		services.activity.start();
		services.anon.loadSaltScheduler();
		client.user.setPresence({
			activities: [{ name: 'secure zone ops' }],
			status: 'online'
		});
	}
};
