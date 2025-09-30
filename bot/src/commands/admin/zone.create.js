const crypto = require('node:crypto');
const {
        SlashCommandBuilder,
        MessageFlags,
        PermissionFlagsBits,
        ActionRowBuilder,
        StringSelectMenuBuilder
} = require('discord.js');

const pendingSelections = new Map();
const TTL_MS = 5 * 60 * 1000;

function cleanupExpired() {
        const now = Date.now();
        for (const [token, meta] of pendingSelections.entries()) {
                if (now - meta.createdAt > TTL_MS) {
                        pendingSelections.delete(token);
                }
        }
}

module.exports = {
        ownerOnly: true,
        data: new SlashCommandBuilder()
                .setName('zone-create')
                .setDescription('Créer une nouvelle zone')
                .setDMPermission(false)
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addStringOption((o) => o.setName('name').setDescription('Nom de la zone').setRequired(true))
                .addUserOption((o) => o.setName('owner').setDescription('Propriétaire de la zone').setRequired(true)),
        async execute(interaction, ctx) {
                const name = interaction.options.getString('name', true);
                const owner = interaction.options.getUser('owner', true);

                cleanupExpired();

                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                const token = crypto.randomBytes(8).toString('hex');
                pendingSelections.set(token, {
                        name,
                        ownerId: owner.id,
                        guildId: interaction.guildId,
                        actorId: interaction.user.id,
                        createdAt: Date.now()
                });

                const row = new ActionRowBuilder().addComponents(
                        new StringSelectMenuBuilder()
                                .setCustomId(`admin:zonecreate:${token}`)
                                .setPlaceholder('Choisis la politique')
                                .addOptions(
                                        { label: 'Fermé', value: 'closed', description: 'Accès uniquement sur ajout manuel.' },
                                        { label: 'Sur demande', value: 'ask', description: 'Les demandes doivent être validées.' },
                                        { label: 'Ouvert', value: 'open', description: 'Tout le monde peut rejoindre.' }
                                )
                );

                await interaction.editReply({
                        content: `Sélectionne la politique d’entrée pour **${name}** :`,
                        components: [row]
                });
        },
        async handlePolicySelect(interaction, ctx) {
                const [_, __, token] = interaction.customId.split(':');
                const entry = pendingSelections.get(token);
                if (!entry) {
                        await interaction.reply({ content: 'Cette demande a expiré.', flags: MessageFlags.Ephemeral }).catch(() => {});
                        return true;
                }

                if (entry.actorId !== interaction.user.id) {
                        await interaction.reply({ content: 'Tu ne peux pas finaliser cette création.', flags: MessageFlags.Ephemeral }).catch(() => {});
                        return true;
                }

                const selected = interaction.values?.[0];
                if (!selected || !['closed', 'ask', 'open'].includes(selected)) {
                        await interaction.reply({ content: 'Sélection invalide.', flags: MessageFlags.Ephemeral }).catch(() => {});
                        return true;
                }

                pendingSelections.delete(token);

                await interaction.deferUpdate().catch(() => {});

                try {
                        const result = await ctx.services.zone.createZone(interaction.guild, {
                                name: entry.name,
                                ownerUserId: entry.ownerId,
                                policy: selected
                        });

                        await interaction.message.edit({ components: [] }).catch(() => {});
                        await interaction
                                .followUp({
                                        content: `✅ Zone **${entry.name}** créée (slug: ${result.slug}).`,
                                        flags: MessageFlags.Ephemeral
                                })
                                .catch(() => {});
                } catch (err) {
                        ctx.logger.error({ err }, 'zone-create select failed');
                        await interaction
                                .followUp({ content: '❌ Échec de création de la zone.', flags: MessageFlags.Ephemeral })
                                .catch(() => {});
                }

                return true;
        }
};
