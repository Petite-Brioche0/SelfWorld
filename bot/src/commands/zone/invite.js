module.exports = {
	command: 'zone',
	subCommand: 'invite',
	description: 'Inviter un membre dans la zone',
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addUserOption((option) => option.setName('user').setDescription('Membre à inviter').setRequired(true));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const user = interaction.options.getUser('user', true);
		const zone = await services.zone.getZoneBySlug(interaction.guild.id, slug);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', ephemeral: true });
			return;
		}
		await services.zone.ensureZoneOwner(zone.id, interaction.user.id);
		await services.zone.addMember(zone.id, user.id);
		await interaction.reply({ content: `${user} a été invité et ajouté.`, ephemeral: true });
	}
};