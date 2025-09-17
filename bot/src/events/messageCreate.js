module.exports = {
	name: 'messageCreate',
	async execute(message, client) {
		if (!message.guild || message.author.bot) {
			return;
		}

		const { anon } = client.context.services;
		await anon.handleMessage(message).catch((error) => {
			client.context.logger.error({ err: error, messageId: message.id }, 'Anon relay failure');
		});
	}
};
