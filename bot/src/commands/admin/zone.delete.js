const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
	ownerOnly: true,
	data: new SlashCommandBuilder()
		.setName('zone-delete')
		.setDescription('Supprimer une zone et toutes ses ressources.')
		.addIntegerOption((option) =>
			option
				.setName('zone_id')
				.setDescription('Identifiant numérique de la zone à supprimer')
				.setRequired(true)
		),
	async execute(interaction, ctx) {
		const zoneId = interaction.options.getInteger('zone_id', true);
		await interaction.deferReply({ ephemeral: true });

		try {
			const result = await ctx.services.zone.deleteZone(interaction.guild, zoneId);
			if (!result.success) {
				const embed = new EmbedBuilder()
					.setColor(0xed4245)
					.setTitle('Suppression impossible')
					.setDescription(`❌ ${result.reason}`)
					.setTimestamp();
				return interaction.editReply({ embeds: [embed] });
			}

			const embed = new EmbedBuilder()
				.setColor(0x57f287)
				.setTitle('Zone supprimée')
				.setDescription(`✅ Zone \`${result.zone.name}\` (#${result.zone.id}) supprimée.`)
				.addFields(
					{ name: 'Slug', value: result.zone.slug, inline: true },
					{ name: 'Owner', value: `<@${result.zone.owner_user_id}>`, inline: true }
				)
				.setTimestamp();
			return interaction.editReply({ embeds: [embed] });
		} catch (err) {
			ctx.logger.error({ err, zoneId }, 'zone-delete failed');
			const embed = new EmbedBuilder()
				.setColor(0xed4245)
				.setTitle('Erreur lors de la suppression')
				.setDescription('❌ Une erreur est survenue en supprimant la zone.')
				.setTimestamp();
			return interaction.editReply({ embeds: [embed] });
		}
	}
};
