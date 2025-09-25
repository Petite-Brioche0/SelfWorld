const { MessageFlags } = require('discord.js');

module.exports = {
	command: 'event',
	rootDescription: 'Coordination des évènements',
	subCommand: 'join',
	description: 'Rejoindre un évènement inter-zone',
	build(builder) {
		builder
		.addStringOption((option) => option.setName('name').setDescription("Nom ou identifiant de l'évènement").setRequired(true))
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone utilisée pour participer').setRequired(true));
	},
	async execute(interaction, { services }) {
		const name = interaction.options.getString('name', true);
		const slug = interaction.options.getString('slug', true);
		const zone = await services.zone.getZoneBySlug(interaction.guild.id, slug);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral });
                        return;
                }
                const isMember = await services.zone.ensureZoneMember(zone.id, interaction.user.id, zone);
                if (!isMember) {
                        await interaction.reply({ content: 'Tu dois être membre de cette zone pour participer.', flags: MessageFlags.Ephemeral });
                        return;
                }

                try {
                        await services.event.joinEvent(name, zone.id, interaction.user.id);
                        await interaction.reply({ content: 'Votre participation a été enregistrée.', flags: MessageFlags.Ephemeral });
                } catch (err) {
                        await interaction.reply({ content: `Impossible de vous inscrire : ${err.message || err}`, flags: MessageFlags.Ephemeral });
                }
        }
};