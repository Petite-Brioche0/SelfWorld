module.exports = {
	name: 'guildCreate',
	once: false,
	async execute(guild, client) {
		const { logger, services } = client.context;
		try {
			await services.guildSetup?.onGuildCreate?.(guild);
		} catch (err) {
			logger.error({ err, guildId: guild.id }, 'guildCreate setup failed');
		}
	}
};
