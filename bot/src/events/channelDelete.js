module.exports = {
	name: 'channelDelete',
	once: false,
	async execute(channel, client) {
		const { logger, services } = client.context;
		try {
			await services.repair?.handleChannelDelete?.(channel);
		} catch (err) {
			logger.warn({ err, channelId: channel?.id }, 'channelDelete handler failed');
		}
	}
};
