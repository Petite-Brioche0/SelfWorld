const { MessageFlags } = require('discord.js');

const POLICIES = ['closed', 'ask', 'invite', 'open'];

module.exports = {
	command: 'zone',
	subCommandGroup: 'policy',
	subCommand: 'set',
	description: "Définir la politique d'adhésion",
	build(builder) {
		builder
		.addStringOption((option) => option.setName('slug').setDescription('Identifiant de la zone').setRequired(true))
		.addStringOption((option) => option.setName('policy').setDescription('Nouvelle politique').setRequired(true).addChoices(
			POLICIES.map((value) => ({ name: value, value }))
		));
	},
	async execute(interaction, { services }) {
		const slug = interaction.options.getString('slug', true);
		const policy = interaction.options.getString('policy', true);
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
                        await services.policy.setPolicy(zone.id, policy);
                        if (services.panel?.refresh) {
                                await services.panel.refresh(zone.id, ['policy']).catch(() => {});
                        }
                        await interaction.reply({ content: `Politique mise à jour sur \`${policy}\`.`, flags: MessageFlags.Ephemeral });
                } catch (err) {
                        await interaction.reply({ content: `Impossible de mettre à jour la politique : ${err.message || err}`, flags: MessageFlags.Ephemeral });
                }
        }
};