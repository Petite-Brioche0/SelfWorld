module.exports = {
	command: 'zone',
	subCommandGroup: 'role',
	subCommand: 'rename',
	description: 'Renommer un rôle de zone',
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addRoleOption((option) => option.setName('role').setDescription('Rôle à renommer').setRequired(true))
		.addStringOption((option) => option.setName('name').setDescription('Nouveau nom').setRequired(true));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const role = interaction.options.getRole('role', true);
		const name = interaction.options.getString('name', true).slice(0, 100);
		const zone = await services.zone.getZoneBySlug(interaction.guild.id, slug);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', ephemeral: true });
			return;
		}
		await services.zone.ensureZoneOwner(zone.id, interaction.user.id);
		await services.zone.renameRole(zone.id, role.id, name);
		await interaction.reply({ content: `Rôle ${role} renommé.`, ephemeral: true });
	}
};