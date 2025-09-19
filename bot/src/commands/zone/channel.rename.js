const { MessageFlags } = require('discord.js');

module.exports = {
	command: 'zone',
	subCommandGroup: 'channel',
	subCommand: 'rename',
	description: 'Renommer un canal',
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addChannelOption((option) => option.setName('channel').setDescription('Canal à renommer').setRequired(true))
		.addStringOption((option) => option.setName('name').setDescription('Nouveau nom').setRequired(true));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const channel = interaction.options.getChannel('channel', true);
		const name = interaction.options.getString('name', true);
		const zone = await services.zone.getZoneBySlug(interaction.guild.id, slug);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral });
                        return;
                }
		await services.zone.ensureZoneOwner(zone.id, interaction.user.id);
		await services.zone.renameChannel(channel.id, name);
                await interaction.reply({ content: `Canal ${channel} renommé.`, flags: MessageFlags.Ephemeral });
        }
};