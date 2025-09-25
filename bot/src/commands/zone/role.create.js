const { MessageFlags } = require('discord.js');

module.exports = {
	command: 'zone',
	subCommandGroup: 'role',
	subCommand: 'create',
	description: 'Créer un rôle local',
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addStringOption((option) => option.setName('name').setDescription('Nom du rôle').setRequired(true));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const name = interaction.options.getString('name', true).slice(0, 100);
		const zone = await services.zone.getZoneBySlug(interaction.guild.id, slug);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral });
                        return;
                }
                const isOwner = await services.zone.ensureZoneOwner(zone.id, interaction.user.id, zone);
                if (!isOwner) {
                        await interaction.reply({ content: 'Seul le propriétaire de cette zone peut faire cette action.', flags: MessageFlags.Ephemeral });
                        return;
                }

                try {
                        const role = await services.zone.createRole(zone.id, name);
                        await interaction.reply({ content: `Rôle ${role} créé.`, flags: MessageFlags.Ephemeral });
                } catch (err) {
                        await interaction.reply({ content: `Impossible de créer ce rôle : ${err.message || err}`, flags: MessageFlags.Ephemeral });
                }
        }
};