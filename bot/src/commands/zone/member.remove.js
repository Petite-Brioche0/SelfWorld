const { MessageFlags } = require('discord.js');

module.exports = {
	command: 'zone',
	subCommandGroup: 'member',
	subCommand: 'remove',
	description: 'Retirer un membre de la zone',
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addUserOption((option) => option.setName('user').setDescription('Membre à retirer').setRequired(true));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const user = interaction.options.getUser('user', true);
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
                        await services.zone.removeMember(zone.id, user.id);
                        await interaction.reply({ content: `${user} retiré de la zone.`, flags: MessageFlags.Ephemeral });
                } catch (err) {
                        await interaction.reply({ content: `Impossible de retirer ce membre : ${err.message || err}`, flags: MessageFlags.Ephemeral });
                }
        }
};