const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
	ownerOnly: true,
	data: new SlashCommandBuilder()
		.setName('repair')
		.setDescription('Analyser le serveur et détecter les ressources bot manquantes')
		.setDMPermission(false)
		.setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

	async execute(interaction, ctx) {
		const guildId = interaction.guild.id;
		const repairService = ctx.services?.repair;

		if (!repairService) {
			return interaction.editReply({ content: '❌ Service de réparation non disponible.' });
		}

		const { issues, guild } = await repairService.scanGuild(guildId);

		if (!guild) {
			return interaction.editReply({ content: '❌ Impossible de charger le serveur Discord.' });
		}

		if (!issues.length) {
			const embed = new EmbedBuilder()
				.setTitle('✅ Analyse terminée — Tout est en ordre')
				.setColor(0x57f287)
				.setDescription(
					'Toutes les ressources gérées par le bot ont été vérifiées.\n' +
					'Aucun salon, catégorie ou rôle manquant n\'a été détecté.'
				)
				.setTimestamp();

			return interaction.editReply({ embeds: [embed] });
		}

		// Build a report embed
		const lines = issues.map((issue) => {
			switch (issue.type) {
			case 'zone_category':
				return `🔴 **Catégorie** — Zone "${issue.zone?.name}" (ID #${issue.zoneId})`;
			case 'zone_channel':
				return `🔴 **Salon** \`${issue.field}\` — Zone "${issue.zone?.name}" (ID #${issue.zoneId})`;
			case 'zone_role':
				return `🔴 **Rôle** \`${issue.field}\` — Zone "${issue.zone?.name}" (ID #${issue.zoneId})`;
			case 'settings_channel':
				return `🟠 **Salon settings** \`${issue.column}\` — Reconfigurer via \`/setup\``;
			default:
				return `⚠️ ${issue.type}`;
			}
		});

		const embed = new EmbedBuilder()
			.setTitle(`⚠️ Analyse terminée — ${issues.length} problème${issues.length > 1 ? 's' : ''} détecté${issues.length > 1 ? 's' : ''}`)
			.setColor(0xed4245)
			.setDescription(lines.join('\n') + '\n\u200b')
			.addFields({
				name: 'Que faire ?',
				value:
					'Cliquez sur **Tout réparer** pour tenter de recréer automatiquement toutes les ressources manquantes.\n' +
					'Les salons de configuration (settings) doivent être reconfigurés manuellement via `/setup`.'
			})
			.setTimestamp();

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId('repair:scan:all')
				.setLabel('🔧 Tout réparer')
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId('repair:ignore')
				.setLabel('✖️ Ignorer')
				.setStyle(ButtonStyle.Secondary)
		);

		return interaction.editReply({ embeds: [embed], components: [row] });
	}
};
