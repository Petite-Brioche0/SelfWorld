module.exports = {
	name: 'messageCreate',
	async execute(message, client) {
		if (!message.guild || message.author.bot) {
			return;
		}

		const services = client.context.services || {};
		const logger = client.context.logger;

		const anon = services.anon;
		if (anon?.handleMessage) {
			await anon.handleMessage(message).catch((error) => {
				logger?.error({ err: error, messageId: message.id }, 'Anon relay failure');
			});
		}

		const zoneService = services.zone;
		const activityService = services.activity;
		if (!zoneService?.resolveZoneContextForChannel || !activityService?.addMessage) {
			return;
		}

		try {
			const context = await zoneService.resolveZoneContextForChannel(message.channel);
			if (!context?.zone?.id) return;
			if (context.kind === 'panel') return; // ignore management panel traffic
			await activityService.addMessage(context.zone.id).catch((err) => {
				logger?.warn({ err, zoneId: context.zone.id }, 'Failed to record zone message activity');
			});
		} catch (err) {
			logger?.warn({ err, messageId: message.id }, 'Zone activity tracking failed');
		}
	}
};
