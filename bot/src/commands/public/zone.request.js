module.exports = {
	command: 'zone',
	subCommand: 'request',
	description: 'Demander la création d'une zone',
	build(builder) {
		builder.setDescription('Demander la création d'une zone');
	},
	async execute(interaction, { services }) {
		await interaction.showModal(services.zone.buildRequestModal());
	}
};