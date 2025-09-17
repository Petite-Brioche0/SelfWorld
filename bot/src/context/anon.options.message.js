const { ContextMenuCommandBuilder, ApplicationCommandType } = require('discord.js');

module.exports = {
	data: new ContextMenuCommandBuilder().setName('Anon options').setType(ApplicationCommandType.Message),
	async execute(interaction, { services }) {
		const targetMessage = await interaction.channel.messages.fetch(interaction.targetId).catch(() => null);
		await services.anon.presentOptions(interaction, { message: targetMessage });
	}
};