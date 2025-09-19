const { MessageFlags } = require('discord.js');

module.exports = {
	command: 'zone',
	subCommandGroup: 'channel',
	subCommand: 'create',
	description: 'Créer un canal dans la zone',
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addStringOption((option) => option.setName('type').setDescription('Type de canal').setRequired(true).addChoices(
			{ name: 'text', value: 'text' },
			{ name: 'voice', value: 'voice' }
		))
		.addStringOption((option) => option.setName('name').setDescription('Nom du canal').setRequired(true));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const type = interaction.options.getString('type', true);
		const name = interaction.options.getString('name', true);
		const zone = await services.zone.getZoneBySlug(interaction.guild.id, slug);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral });
                        return;
                }
		await services.zone.ensureZoneOwner(zone.id, interaction.user.id);
		const channel = await services.zone.createChannel(zone.id, type, name);
                await interaction.reply({ content: `Canal ${channel} créé.`, flags: MessageFlags.Ephemeral });
        }
};