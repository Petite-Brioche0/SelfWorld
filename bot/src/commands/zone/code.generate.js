const { MessageFlags } = require('discord.js');

module.exports = {
	command: 'zone',
	subCommandGroup: 'code',
	subCommand: 'generate',
	description: "Générer un code d'invitation à usage unique",
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addUserOption((option) => option.setName('user').setDescription('Membre ciblé').setRequired(true))
		.addIntegerOption((option) => option.setName('ttl').setDescription('Durée de validité en minutes').setRequired(true).setMinValue(5).setMaxValue(1440));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const user = interaction.options.getUser('user', true);
		const ttl = interaction.options.getInteger('ttl', true);
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
                        const { code, expiresAt } = await services.zone.generateJoinCode(zone.id, user.id, ttl);
                        await interaction.reply({ content: `Code pour ${user}: \`${code}\` (expire ${expiresAt.toLocaleString()}).`, flags: MessageFlags.Ephemeral });
                } catch (err) {
                        await interaction.reply({ content: `Impossible de générer un code : ${err.message || err}`, flags: MessageFlags.Ephemeral });
                }
        }
};