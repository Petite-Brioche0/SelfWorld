const { MessageFlags } = require('discord.js');

module.exports = {
	command: 'zone',
	subCommandGroup: 'role',
	subCommand: 'delete',
	description: 'Supprimer un rôle de zone',
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addRoleOption((option) => option.setName('role').setDescription('Rôle à supprimer').setRequired(true));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const role = interaction.options.getRole('role', true);
		const zone = await services.zone.getZoneBySlug(interaction.guild.id, slug);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral });
                        return;
                }
		await services.zone.ensureZoneOwner(zone.id, interaction.user.id);
		await services.zone.deleteRole(zone.id, role.id);
                await interaction.reply({ content: `Rôle ${role.name} supprimé.`, flags: MessageFlags.Ephemeral });
        }
};