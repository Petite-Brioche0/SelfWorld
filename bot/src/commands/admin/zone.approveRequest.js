const { MessageFlags } = require('discord.js');

module.exports = {
	command: 'zone',
	subCommandGroup: 'admin',
	subCommand: 'approve-request',
	description: 'Approuver une demande manuellement',
	globalOwnerOnly: true,
	build(builder) {
		builder.addIntegerOption((option) => option.setName('request_id').setDescription('Identifiant de la demande').setRequired(true));
	},
	async execute(interaction, { services }) {
		const requestId = interaction.options.getInteger('request_id', true);
		await services.policy.approveRequest(requestId, interaction.user.id);
                await interaction.reply({ content: `Demande #${requestId} approuvée.`, flags: MessageFlags.Ephemeral });
        }
};