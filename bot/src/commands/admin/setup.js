const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
	ownerOnly: true,
	data: new SlashCommandBuilder()
		.setName('setup')
		.setDescription('Ouvrir ou recréer le salon de configuration du bot')
		.setDMPermission(false)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	async execute(interaction, ctx) {
		try {
			const { channel, isNew } = await ctx.services.guildSetup.ensureSetupChannel(interaction.guild);

			const content = isNew
				? `✅ **Salon de configuration recréé**\n\nUn nouveau salon a été créé : ${channel}\n\n> Tous les réglages existants ont été conservés.`
				: `📋 **Salon de configuration existant**\n\nLe salon de configuration est disponible ici : ${channel}\n\n> Utilisez les boutons dans ce salon pour modifier la configuration.`;

			return interaction.editReply({ content });
		} catch (err) {
			ctx.logger?.error({ err }, '/setup command failed');
			return interaction.editReply({ content: '❌ Une erreur est survenue lors de la création du salon de configuration.' });
		}
	}
};
