module.exports = {
	command: 'settings',
	rootDescription: 'Paramètres de la communauté',
	subCommandGroup: 'anonlog',
	groupDescription: 'Confidentialité des journaux',
	subCommand: 'set',
	description: 'Définir le canal de journal anonyme',
	globalOwnerOnly: true,
	build(builder) {
		builder.addChannelOption((option) => option.setName('channel').setDescription('Canal recevant les logs anonymes').setRequired(true));
	},
	async execute(interaction, { services }) {
		const channel = interaction.options.getChannel('channel');
		if (!channel || !channel.isTextBased()) {
			await interaction.reply({ content: 'Merci de sélectionner un canal textuel.', ephemeral: true });
			return;
		}
		await services.anon.setLogChannel(interaction.guild.id, channel.id);
		await interaction.reply({ content: `Canal de log anonyme défini sur ${channel}.`, ephemeral: true });
	}
};