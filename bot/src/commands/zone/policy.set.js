const POLICIES = ['closed', 'ask', 'invite', 'open'];

module.exports = {
	command: 'zone',
	subCommandGroup: 'policy',
	subCommand: 'set',
	description: "Définir la politique d'adhésion",
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addStringOption((option) => option.setName('policy').setDescription('Nouvelle politique').setRequired(true).addChoices(
			POLICIES.map((value) => ({ name: value, value }))
		));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const policy = interaction.options.getString('policy', true);
		const zone = await services.zone.getZoneBySlug(interaction.guild.id, slug);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', ephemeral: true });
			return;
		}
		await services.zone.ensureZoneOwner(zone.id, interaction.user.id);
		await services.policy.setPolicy(zone.id, policy);
		await interaction.reply({ content: `Politique mise à jour sur \`${policy}\`.`, ephemeral: true });
	}
};