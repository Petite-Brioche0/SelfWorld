module.exports = {
	name: 'messageDelete',
	once: false,
	async execute(message, client) {
		const { logger, services } = client.context;
		try {
			await services.repair?.handleMessageDelete?.(message);
		} catch (err) {
			logger.warn({ err, messageId: message?.id }, 'messageDelete handler failed');
		}
	}
};
