
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
	ownerOnly: true,
	data: new SlashCommandBuilder()
		.setName('zone-create')
		.setDescription('Créer une nouvelle zone')
		.addStringOption(o => o.setName('name').setDescription('Nom de la zone').setRequired(true))
		.addUserOption(o => o.setName('owner').setDescription('Propriétaire de la zone').setRequired(true))
		.addStringOption(o => o.setName('policy').setDescription('Politique')
			.addChoices(
				{ name: 'closed', value: 'closed' },
				{ name: 'ask', value: 'ask' },
				{ name: 'invite', value: 'invite' },
				{ name: 'open', value: 'open' }
			).setRequired(true)
		),
	async execute(interaction, ctx) {
		const name = interaction.options.getString('name', true);
		const owner = interaction.options.getUser('owner', true);
		const policy = interaction.options.getString('policy', true);

		await interaction.deferReply({ ephemeral: true });

		try {
			const res = await ctx.services.zone.createZone(interaction.guild, { name, ownerUserId: owner.id, policy });
			return interaction.editReply(`✅ Zone \`${name}\` créée (slug: ${res.slug}).`);
		} catch (err) {
			ctx.logger.error({ err }, 'zone-create failed');
			return interaction.editReply('❌ Échec de création de la zone.');
		}
	}
};
