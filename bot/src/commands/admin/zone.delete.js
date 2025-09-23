const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');

async function safeFetchChannel(client, id) { if (!id) return null; try { return await client.channels.fetch(id); } catch { return null; } }
async function safeDeleteChannel(ch) { if (ch) { try { await ch.delete('Zone delete'); } catch {} } }
async function safeFetchRole(guild, id) { if (!id) return null; try { return await guild.roles.fetch(id); } catch { return null; } }
async function safeDeleteRole(role) { if (role) { try { await role.delete('Zone delete'); } catch {} } }

async function columnExists(pool, table, column) {
	const [rows] = await pool.query(
		"SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=? LIMIT 1",
		[table, column]
	);
	return rows.length > 0;
}

module.exports = {
	ownerOnly: true,
	data: new SlashCommandBuilder()
		.setName('zone-delete')
		.setDescription('Supprimer une zone par ID (admin only)')
		.addIntegerOption(o => o.setName('id').setDescription('ID de la zone').setRequired(true)),

	async execute(interaction, ctx) {
		// utilise les flags pour éviter le warning "ephemeral deprecated"
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		const ownerId = ctx.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID;
		if (interaction.user.id !== ownerId) {
			return interaction.editReply({ content: 'Commande réservée à l’Owner.' });
		}

		const zoneId = interaction.options.getInteger('id', true);

		try {
			// Charger la zone
			const [rows] = await ctx.pool.query('SELECT * FROM zones WHERE id=? AND guild_id=?', [zoneId, interaction.guild.id]);
			const zone = rows?.[0];
			if (!zone) return interaction.editReply(`Zone #${zoneId} introuvable.`);

			// Supprimer ressources Discord (safe)
			const guild = interaction.guild;
			const cat = await safeFetchChannel(interaction.client, zone.category_id);
			const chPanel = await safeFetchChannel(interaction.client, zone.text_panel_id);
			const chReception = await safeFetchChannel(interaction.client, zone.text_reception_id);
			const chGeneral = await safeFetchChannel(interaction.client, zone.text_general_id);
			const chAnon = await safeFetchChannel(interaction.client, zone.text_anon_id);
			const chVoice = await safeFetchChannel(interaction.client, zone.voice_id);
			await safeDeleteChannel(chPanel);
			await safeDeleteChannel(chReception);
			await safeDeleteChannel(chGeneral);
			await safeDeleteChannel(chAnon);
			await safeDeleteChannel(chVoice);
			await safeDeleteChannel(cat);

                        const rOwner = await safeFetchRole(guild, zone.role_owner_id);
                        const rMember = await safeFetchRole(guild, zone.role_member_id);
                        await safeDeleteRole(rOwner);
                        await safeDeleteRole(rMember);

			// Nettoyage DB (défensif : on teste d’abord la présence des colonnes)
			await ctx.pool.query('DELETE FROM anon_channels WHERE zone_id=?', [zoneId]).catch(()=>{});
			await ctx.pool.query('DELETE FROM join_requests WHERE zone_id=?', [zoneId]).catch(()=>{});
			await ctx.pool.query('DELETE FROM zone_activity WHERE zone_id=?', [zoneId]).catch(()=>{});
			await ctx.pool.query('DELETE FROM event_participants WHERE zone_id=?', [zoneId]).catch(()=>{});

			// temp_groups: certaines versions de ton schéma n’ont pas zone_id → on vérifie
			if (await columnExists(ctx.pool, 'temp_groups', 'zone_id')) {
				await ctx.pool.query('DELETE FROM temp_group_members WHERE group_id IN (SELECT id FROM temp_groups WHERE zone_id=?)', [zoneId]).catch(()=>{});
				await ctx.pool.query('DELETE FROM temp_groups WHERE zone_id=?', [zoneId]).catch(()=>{});
			} // sinon on ignore proprement

			// Enfin, supprimer la zone
			await ctx.pool.query('DELETE FROM zones WHERE id=?', [zoneId]);

			const embed = new EmbedBuilder()
				.setColor(0x57f287)
				.setTitle('Zone supprimée')
				.setDescription(`✅ La zone **#${zoneId}** (\`${zone.slug}\`) a été supprimée.`)
				.setTimestamp();

			return interaction.editReply({ embeds: [embed] });
		} catch (err) {
			// On répond quand même pour ne pas laisser l’interaction en suspens
			await interaction.editReply({ content: `❌ Échec de suppression : \`${err?.message || err}\`` });
		}
	}
};
