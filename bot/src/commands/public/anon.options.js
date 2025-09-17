module.exports = {
	command: 'anon',
	rootDescription: 'Outils d'anonymat',
	subCommand: 'options',
	description: 'Afficher les options anonymes',
	build(builder) {
		builder.setDescription('Afficher les actions disponibles en anonyme');
	},
	async execute(interaction, { services }) {
		await services.anon.presentOptions(interaction);
	}
};