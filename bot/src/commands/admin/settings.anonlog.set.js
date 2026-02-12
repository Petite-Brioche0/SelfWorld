// Future: Unify all settings (anon, requests, events) into a single settings panel command
// See: https://github.com/Petite-Brioche0/SelfWorld/issues (create issue for unified settings)

// Sets the admin log channel for anonymous messages
const { SlashCommandBuilder, ChannelType, MessageFlags, PermissionFlagsBits } = require('discord.js');

module.exports = {
	ownerOnly: true,
	data: new SlashCommandBuilder()
		.setName('settings-anonlog-set')
		.setDescription('Définir le salon admin pour le log des messages anonymes')
		.setDMPermission(false)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
		.addChannelOption(o => o.setName('channel').setDescription('Salon #public-anonyme').addChannelTypes(ChannelType.GuildText).setRequired(true)),
	async execute(interaction, ctx) {
		try {
			const ch = interaction.options.getChannel('channel', true);
			if (!interaction.deferred && !interaction.replied) {
				await interaction.deferReply({ flags: MessageFlags.Ephemeral });
			}

			await ctx.pool.query(
				'INSERT INTO settings (guild_id, anon_admin_channel_id, created_at) VALUES (?, ?, NOW()) AS new ON DUPLICATE KEY UPDATE anon_admin_channel_id = new.anon_admin_channel_id',
				[interaction.guild.id, ch.id]
			);

			return interaction.editReply(`✅ **Salon configuré**\n\nLe salon d'agrégation anonyme a été défini sur ${ch}.\n\n> 💡 *Tous les messages anonymes seront maintenant loggés dans ce salon.*`);
		} catch (err) {
			ctx.logger?.error({ err }, 'settings-anonlog-set command failed');
			const content = '❌ Une erreur est survenue lors de la configuration.';
			if (interaction.deferred || interaction.replied) {
				await interaction.editReply({ content }).catch(() => {});
			} else {
				await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
			}
		}
	}
};
