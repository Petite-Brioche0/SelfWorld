
const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');

function chunk(arr, size) {
	const out = [];
	for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
	return out;
}

module.exports = {
        ownerOnly: true,
        data: new SlashCommandBuilder()
                .setName('zones-list')
                .setDescription('Liste toutes les zones (admin only)')
                .setDMPermission(false)
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

        async execute(interaction, ctx) {
                if (!interaction.deferred && !interaction.replied) {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                }

		const ownerId = ctx.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID;
		if (interaction.user.id !== ownerId) {
			return interaction.editReply({ content: 'Commande réservée à l’Owner.' });
		}

		const [rows] = await ctx.pool.query(
			`SELECT id, name, slug, owner_user_id, policy, created_at
			 FROM zones WHERE guild_id=? ORDER BY id ASC`,
			[interaction.guild.id]
		);

		if (!rows.length) {
			return interaction.editReply('Aucune zone enregistrée.');
		}

		// Build embeds in pages to avoid 6000 chars limit
		const pages = chunk(rows, 15).map((slice, idx) => {
			const desc = slice.map(z =>
				`• **#${z.id}** — \`${z.slug}\` — **${z.name}**\n` +
				`   Owner: <@${z.owner_user_id}> • policy: \`${z.policy}\` • created: \`${new Date(z.created_at).toISOString().slice(0,19).replace('T',' ')}\``
			).join('\n');

			return new EmbedBuilder()
				.setColor(0x5865f2)
				.setTitle('Zones enregistrées')
				.setDescription(desc)
				.setFooter({ text: `Page ${idx+1}/${Math.ceil(rows.length/15)}` })
				.setTimestamp();
		});

		// If only one page
		if (pages.length === 1) {
			return interaction.editReply({ embeds: pages });
		}
		// Multiple pages -> send first then followups
		await interaction.editReply({ embeds: [pages[0]] });
		for (let i = 1; i < pages.length; i++) {
                        await interaction.followUp({ embeds: [pages[i]], flags: MessageFlags.Ephemeral });
                }
        }
};
