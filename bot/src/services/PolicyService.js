const { EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } = require('discord.js');

const { withTransaction } = require('../utils/db');

const ALLOWED_POLICIES = ['closed', 'ask', 'invite', 'open'];

class PolicyService {
	constructor(client, pool, zoneService, logger) {
		this.client = client;
		this.pool = pool;
		this.zoneService = zoneService;
		this.logger = logger;
	}

	async setPolicy(zoneId, policy) {
		if (!ALLOWED_POLICIES.includes(policy)) {
			throw new Error('Politique invalide.');
		}
		await this.pool.query('UPDATE zones SET policy = ? WHERE id = ?', [policy, zoneId]);
		return policy;
	}

	async createJoinRequest(zoneId, applicantId, reason) {
		const zone = await this.zoneService.getZoneById(zoneId);
		if (!zone) {
			throw new Error('Zone introuvable');
		}
		const guild = await this.client.guilds.fetch(zone.guild_id);
		const receptionChannel = guild.channels.cache.get(zone.text_reception_id);
		if (!receptionChannel) {
			throw new Error('Salon de réception introuvable');
		}
		return withTransaction(async (conn) => {
			const [result] = await conn.query(
				'INSERT INTO join_requests (zone_id, applicant_user_id, status) VALUES (?, ?, ?)',
				[zoneId, applicantId, 'pending']
			);
			const requestId = result.insertId;
			const embed = new EmbedBuilder()
			.setTitle('Nouvelle demande de rejoindre la zone')
			.setDescription(reason || 'Aucune justification fournie')
			.addFields({ name: 'Membre', value: `<@${applicantId}>`, inline: true })
			.setFooter({ text: `Demande #${requestId}` })
			.setTimestamp();
			const message = await receptionChannel.send({
				embeds: [embed],
				components: [
					new ActionRowBuilder().addComponents(
						new ButtonBuilder().setCustomId(`policy:approve:${requestId}`).setLabel('Approuver').setStyle(ButtonStyle.Success),
						new ButtonBuilder().setCustomId(`policy:reject:${requestId}`).setLabel('Refuser').setStyle(ButtonStyle.Danger)
					)
				]
			});
			await conn.query('UPDATE join_requests SET message_id = ? WHERE id = ?', [message.id, requestId]);
			return { requestId, messageId: message.id };
		});
	}

	async handlePolicyButton(interaction) {
		const [action, requestId] = interaction.customId.split(':').slice(1);
		if (!['approve', 'reject'].includes(action)) {
			await interaction.reply({ content: 'Action inconnue.', ephemeral: true });
			return;
		}
		const request = await this.getRequest(Number(requestId));
		if (!request) {
			await interaction.reply({ content: 'Demande introuvable ou déjà traitée.', ephemeral: true });
			return;
		}
		const zone = await this.zoneService.getZoneById(request.zone_id);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', ephemeral: true });
			return;
		}
		try {
			await this.zoneService.ensureZoneOwner(zone.id, interaction.user.id);
		} catch (authError) {
			await interaction.reply({ content: 'Seul le propriétaire peut traiter cette demande.', ephemeral: true });
			return;
		}
		if (action === 'approve') {
			await this.approveRequest(request.id, interaction.user.id);
			await interaction.reply({ content: 'Demande approuvée.', ephemeral: true });
		} else {
			await this.rejectRequest(request.id, interaction.user.id);
			await interaction.reply({ content: 'Demande refusée.', ephemeral: true });
		}
	}

	async approveRequest(requestId, approverId) {
		const request = await this.getRequest(requestId);
		if (!request) {
			throw new Error('Demande introuvable');
		}
		await withTransaction(async (conn) => {
			await conn.query('UPDATE join_requests SET status = ?, message_id = NULL WHERE id = ?', ['approved', requestId]);
		});
		await this.zoneService.addMember(request.zone_id, request.applicant_user_id);
		this.logger.info({ requestId, approverId }, 'Join request approved');
	}

	async rejectRequest(requestId, approverId) {
		await withTransaction(async (conn) => {
			await conn.query('UPDATE join_requests SET status = ?, message_id = NULL WHERE id = ?', ['rejected', requestId]);
		});
		this.logger.info({ requestId, approverId }, 'Join request rejected');
	}

	async getRequest(requestId) {
		const [rows] = await this.pool.query('SELECT * FROM join_requests WHERE id = ?', [requestId]);
		return rows[0] || null;
	}
}

module.exports = PolicyService;
module.exports.ALLOWED_POLICIES = ALLOWED_POLICIES;
