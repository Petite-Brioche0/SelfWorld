const { SlashCommandBuilder, ChannelType, MessageFlags } = require('discord.js');
const { applyPanelOverrides } = require('../utils/permissions');

async function fetchRole(guild, roleId) {
	if (!roleId) return null;
	return guild.roles.cache.get(roleId) || await guild.roles.fetch(roleId).catch(() => null);
}

module.exports = {
	data: new SlashCommandBuilder()
		.setName('panel-refresh')
		.setDescription('Rafraîchir le panneau (owner seulement, dans #panel)'),
	async execute(interaction, ctx) {
		await interaction.deferReply({ flags: MessageFlags.Ephemeral });

		try {
			const pool = ctx.pool;
			const [rows] = await pool.query('SELECT * FROM zones WHERE text_panel_id = ?', [interaction.channelId]);
			const zoneRow = rows?.[0];

			if (!zoneRow) {
				await interaction.editReply('Cette commande doit être exécutée dans le salon #panel de ta zone.');
				return;
			}

			const ownerOverride = ctx.config?.ownerUserId || process.env.OWNER_ID || null;
			const memberRoles = interaction.member?.roles?.cache;
			const hasOwnerRole = memberRoles?.has?.(zoneRow.role_owner_id) || false;
			const isOwnerOverride = ownerOverride && interaction.user.id === String(ownerOverride);

			if (!hasOwnerRole && !isOwnerOverride) {
				await interaction.editReply('Seul le propriétaire de cette zone peut rafraîchir le panneau.');
				return;
			}

			const guild = interaction.guild;
			if (!guild) {
				await interaction.editReply('Impossible de déterminer la guilde courante.');
				return;
			}

			let panelChannel = await guild.channels.fetch(zoneRow.text_panel_id).catch(() => null);
			const ownerRole = await fetchRole(guild, zoneRow.role_owner_id);
			const memberRole = await fetchRole(guild, zoneRow.role_member_id);
			const botMember = guild.members.me || await guild.members.fetch(interaction.client.user.id).catch(() => null);
			const botRole = botMember?.roles?.highest || null;

			if (!panelChannel) {
				panelChannel = await guild.channels.create({
					name: 'panel',
					type: ChannelType.GuildText,
					parent: zoneRow.category_id || null,
					reason: 'Recréation du panneau de zone'
				});

				await applyPanelOverrides(panelChannel, {
					everyoneRole: guild.roles.everyone,
					zoneMemberRole: memberRole,
					zoneOwnerRole: ownerRole
				}, botRole);

				await pool.query('UPDATE zones SET text_panel_id = ? WHERE id = ?', [panelChannel.id, zoneRow.id]);
				zoneRow.text_panel_id = panelChannel.id;
			} else {
				await applyPanelOverrides(panelChannel, {
					everyoneRole: guild.roles.everyone,
					zoneMemberRole: memberRole,
					zoneOwnerRole: ownerRole
				}, botRole).catch(() => null);
			}

			await ctx.services.panel.ensurePanel(zoneRow);
			await ctx.services.panel.refresh(zoneRow.id, ['members', 'roles', 'channels', 'policy']);

			ctx.logger?.info({ zoneId: zoneRow.id, actor: interaction.user.id }, 'panel-refresh');

			await interaction.editReply(`✅ Panel rafraîchi dans <#${zoneRow.text_panel_id}>`);
		} catch (err) {
			ctx.logger?.error({ err, actor: interaction.user.id, channelId: interaction.channelId }, 'panel-refresh failed');
			await interaction.editReply('❌ Impossible de rafraîchir le panneau pour le moment.');
		}
	}
};
