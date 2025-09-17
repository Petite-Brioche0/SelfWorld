
const { SlashCommandBuilder, ChannelType } = require('discord.js');

module.exports = {
	ownerOnly: true,
	data: new SlashCommandBuilder()
		.setName('settings-anonlog-set')
		.setDescription('Définir le salon admin pour le log des messages anonymes')
		.addChannelOption(o => o.setName('channel').setDescription('Salon #public-anonyme').addChannelTypes(ChannelType.GuildText).setRequired(true)),
	async execute(interaction, ctx) {
		const ch = interaction.options.getChannel('channel', true);
		await interaction.deferReply({ ephemeral: true });

		await ctx.pool.query(
			'INSERT INTO settings (guild_id, anon_admin_channel_id, created_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE anon_admin_channel_id = VALUES(anon_admin_channel_id)',
			[interaction.guild.id, ch.id]
		);

		return interaction.editReply(`✅ Salon d’agrégation anonyme défini sur ${ch}.`);
	}
};
