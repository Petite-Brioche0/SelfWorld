const POLICIES = ['closed', 'ask', 'invite', 'open'];

module.exports = {
	command: 'zone',
	rootDescription: 'Gestion des zones sécurisées',
	subCommandGroup: 'admin',
	groupDescription: 'Administration globale',
	subCommand: 'create',
	description: 'Créer une nouvelle zone',
	globalOwnerOnly: true,
	build(builder) {
		builder
		.addStringOption((option) => option.setName('name').setDescription('Nom de la zone').setRequired(true))
		.addUserOption((option) => option.setName('owner').setDescription('Propriétaire de la zone').setRequired(true))
		.addStringOption((option) => option.setName('policy').setDescription('Politique de la zone').setRequired(true).addChoices(
			POLICIES.map((value) => ({ name: value, value }))
		));
	},
	async execute(interaction, { services }) {
		const name = interaction.options.getString('name', true);
		const owner = interaction.options.getUser('owner', true);
		const policy = interaction.options.getString('policy', true);
		const guild = interaction.guild;
		const zone = await services.zone.createZone(guild, { name, ownerId: owner.id, policy });
		await interaction.reply({ content: `Zone \`${zone.slug}\` créée pour ${owner}.`, ephemeral: true });
	}
};