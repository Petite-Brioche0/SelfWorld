// Creates a new zone manually, useful for debugging or when the automated zone creation system fails

const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');

const POLICY_CHOICES = [
        { name: 'Fermé', value: 'closed' },
        { name: 'Sur demande', value: 'ask' },
        { name: 'Ouvert', value: 'open' }
];
const POLICY_VALUES = new Set(POLICY_CHOICES.map((choice) => choice.value));

module.exports = {
        ownerOnly: true,
        data: new SlashCommandBuilder()
                .setName('zone-create')
                .setDescription('Créer une nouvelle zone')
                .setDMPermission(false)
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addStringOption((o) => o.setName('name').setDescription('Nom de la zone').setRequired(true))
                .addUserOption((o) => o.setName('owner').setDescription('Propriétaire de la zone').setRequired(true))
                .addStringOption((o) =>
                        o
                                .setName('policy')
                                .setDescription("Politique d'entrée")
                                .setRequired(true)
                                .addChoices(...POLICY_CHOICES)
                ),
        async execute(interaction, ctx) {
                const name = interaction.options.getString('name', true);
                const owner = interaction.options.getUser('owner', true);
                const policy = interaction.options.getString('policy', true);

                if (!POLICY_VALUES.has(policy)) {
                        if (!interaction.deferred && !interaction.replied) {
                                await interaction.reply({
                                        content: '❌ Politique invalide. Choisis fermé, sur demande ou ouvert.',
                                        flags: MessageFlags.Ephemeral
                                }).catch((err) => {
                                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                        ctx.logger?.warn({ err, userId: interaction.user.id }, 'Failed to send invalid policy reply');
                                });
                        } else {
                                await interaction.editReply({
                                        content: '❌ Politique invalide. Choisis fermé, sur demande ou ouvert.'
                                }).catch((err) => {
                                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                        ctx.logger?.warn({ err, userId: interaction.user.id }, 'Failed to edit invalid policy reply');
                                });
                        }
                        return;
                }

                if (!interaction.deferred && !interaction.replied) {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                }

                await interaction.editReply({
                        content: `Création de la zone **${name}** pour ${owner}...`
                }).catch((err) => {
                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                        ctx.logger?.warn({ err, userId: interaction.user.id, zoneName: name }, 'Failed to send zone creation status');
                });

                try {
                        const result = await ctx.services.zone.createZone(interaction.guild, {
                                name,
                                ownerUserId: owner.id,
                                policy
                        });

                        await interaction.editReply({
                                content: `✅ Zone **${name}** créée (slug : ${result.slug}). Propriétaire initial : ${owner}.`
                        });
                } catch (err) {
                        ctx.logger?.error({ err }, 'zone-create failed');
                        await interaction.editReply({
                                content: '❌ Échec de création de la zone. Consulte les logs pour plus de détails.'
                        });
                }
        }
};
