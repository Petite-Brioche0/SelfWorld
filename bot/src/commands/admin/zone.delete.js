// Safely deletes a zone and all associated resources

const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');

async function safeFetchChannel(client, id) { if (!id) return null; try { return await client.channels.fetch(id); } catch { return null; } }
async function safeDeleteChannel(ch) { if (ch) { try { await ch.delete('Zone delete'); } catch { /* ignored */ } } }
async function safeFetchRole(guild, id) { if (!id) return null; try { return await guild.roles.fetch(id); } catch { return null; } }
async function safeDeleteRole(role) { if (role) { try { await role.delete('Zone delete'); } catch { /* ignored */ } } }

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
                .setDMPermission(false)
                .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
                .addIntegerOption(o => o.setName('id').setDescription('ID de la zone').setRequired(true)),

        async execute(interaction, ctx) {
                if (!interaction.deferred && !interaction.replied) {
                        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                }

		const ownerId = ctx.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID;
		if (interaction.user.id !== ownerId) {
			return interaction.editReply({ content: '🔒 **Accès restreint**\n\nCette commande est réservée au propriétaire du bot.' });
		}

		const zoneId = interaction.options.getInteger('id', true);

		try {
			// Charger la zone
			const [rows] = await ctx.pool.query('SELECT * FROM zones WHERE id=? AND guild_id=?', [zoneId, interaction.guild.id]);
			const zone = rows?.[0];
			if (!zone) return interaction.editReply(`❌ **Zone introuvable**\n\nAucune zone avec l'ID **#${zoneId}** n'existe sur ce serveur.`);

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

			// Nettoyage DB - Database cleanups (order matters for foreign keys)

			// Clean custom zone channels (delete Discord channels first, then DB records)
			const [zoneChannels] = await ctx.pool.query(
				'SELECT channel_id FROM zone_channels WHERE zone_id=?',
				[zoneId]
			).catch(() => [[]]);
			for (const row of zoneChannels) {
				await safeDeleteChannel(await safeFetchChannel(interaction.client, row.channel_id));
			}
			await ctx.pool.query('DELETE FROM zone_channels WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'zone_channels cleanup miss'); });

			// Clean temp groups (delete Discord resources first, then DB records)
			if (await columnExists(ctx.pool, 'temp_groups', 'zone_id')) {
				const [tempGroups] = await ctx.pool.query(
					'SELECT id, text_channel_id, voice_channel_id, panel_channel_id, category_id FROM temp_groups WHERE zone_id=?',
					[zoneId]
				).catch(() => [[]]);

				for (const tg of tempGroups) {
					// Delete temp group Discord channels
					await safeDeleteChannel(await safeFetchChannel(interaction.client, tg.text_channel_id));
					await safeDeleteChannel(await safeFetchChannel(interaction.client, tg.voice_channel_id));
					await safeDeleteChannel(await safeFetchChannel(interaction.client, tg.panel_channel_id));
					await safeDeleteChannel(await safeFetchChannel(interaction.client, tg.category_id));

					// Delete temp_group_channels records
					await ctx.pool.query('DELETE FROM temp_group_channels WHERE temp_group_id=?', [tg.id]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'temp_group_channels cleanup miss'); });
				}

				// Delete temp group members and temp groups
				await ctx.pool.query('DELETE FROM temp_group_members WHERE temp_group_id IN (SELECT id FROM temp_groups WHERE zone_id=?)', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'temp_group_members cleanup miss'); });
				await ctx.pool.query('DELETE FROM temp_groups WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'temp_groups cleanup miss'); });
			}

			// Clean zone member roles (user-role assignments)
			await ctx.pool.query('DELETE FROM zone_member_roles WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'zone_member_roles cleanup miss'); });

			// Clean zone members (zone membership records)
			await ctx.pool.query('DELETE FROM zone_members WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'zone_members cleanup miss'); });

			// Clean zone roles (custom zone roles)
			await ctx.pool.query('DELETE FROM zone_roles WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'zone_roles cleanup miss'); });

			// Clean panel messages (panel UI metadata)
			await ctx.pool.query('DELETE FROM panel_messages WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'panel_messages cleanup miss'); });

			// Clean panel message registry
			await ctx.pool.query('DELETE FROM panel_message_registry WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'panel_message_registry cleanup miss'); });

			// Clean zone invite codes
			await ctx.pool.query('DELETE FROM zone_invite_codes WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'zone_invite_codes cleanup miss'); });

			// Clean zone join requests
			await ctx.pool.query('DELETE FROM zone_join_requests WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'zone_join_requests cleanup miss'); });

			// Clean legacy join codes and join_requests (if they exist)
			await ctx.pool.query('DELETE FROM join_codes WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'join_codes cleanup miss'); });
			await ctx.pool.query('DELETE FROM join_requests WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'join_requests cleanup miss'); });

			// Clean anon channels
			await ctx.pool.query('DELETE FROM anon_channels WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'anon_channels cleanup miss'); });

			// Clean anon logs (uses source_zone_id, not zone_id!)
			await ctx.pool.query('DELETE FROM anon_logs WHERE source_zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'anon_logs cleanup miss'); });

			// Clean zone activity
			await ctx.pool.query('DELETE FROM zone_activity WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'zone_activity cleanup miss'); });

			// Clean event participants
			await ctx.pool.query('DELETE FROM event_participants WHERE zone_id=?', [zoneId]).catch((err) => { ctx.logger?.debug({ err, zoneId }, 'event_participants cleanup miss'); });

			// Finally, delete the zone itself
			await ctx.pool.query('DELETE FROM zones WHERE id=?', [zoneId]);

			const embed = new EmbedBuilder()
				.setColor(0x57f287)
				.setTitle('✅ Zone supprimée')
				.setDescription(`La zone **#${zoneId}** (\`${zone.slug}\`) a été supprimée avec succès.\n\nToutes les ressources Discord et données associées ont été nettoyées.`)
				.setTimestamp();

			return interaction.editReply({ embeds: [embed] });
		} catch (err) {
			// On répond quand même pour ne pas laisser l’interaction en suspens
			await interaction.editReply({ content: `❌ Échec de suppression : \`${err?.message || err}\`` });
		}
	}
};
