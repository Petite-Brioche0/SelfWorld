
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

class PolicyService {
	constructor(client, db) {
		this.client = client;
		this.db = db;
	}

	async setPolicy(zoneId, policy) {
		await this.db.query('UPDATE zones SET policy=? WHERE id=?', [policy, zoneId]);
	}

	async createJoinRequestCard(zoneRow, applicantUserId, mode) {
		const recep = await this.client.channels.fetch(zoneRow.text_reception_id).catch(()=>null);
		if (!recep) return null;

		const e = new EmbedBuilder()
			.setTitle('Demande d’entrée')
			.setDescription(`Utilisateur: <@${applicantUserId}>`)
			.addFields({ name: 'Mode', value: mode })
			.setTimestamp();

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(`zone:approve:${zoneRow.id}:${applicantUserId}`).setStyle(ButtonStyle.Success).setLabel('Approuver'),
			new ButtonBuilder().setCustomId(`zone:reject:${zoneRow.id}:${applicantUserId}`).setStyle(ButtonStyle.Danger).setLabel('Refuser'),
		);

		const msg = await recep.send({ embeds: [e], components: [row] });
		await this.db.query('INSERT INTO join_requests (zone_id, applicant_user_id, status, message_id, created_at) VALUES (?, ?, ?, ?, NOW())',
			[zoneRow.id, applicantUserId, 'pending', msg.id]);
		return msg;
	}

	async handleApprovalButton(interaction) {
		const parts = interaction.customId.split(':');
		const approve = parts[1] === 'approve';
		const zoneId = Number(parts[2]);
		const applicant = parts[3];

		const [rows] = await this.db.query('SELECT * FROM zones WHERE id=?', [zoneId]);
		const zone = rows?.[0];
		if (!zone) return interaction.reply({ content: 'Zone introuvable.', ephemeral: true });

		if (interaction.user.id !== String(zone.owner_user_id)) {
			return interaction.reply({ content: 'Seul le propriétaire de cette zone peut décider ici.', ephemeral: true });
		}

		await this.db.query('UPDATE join_requests SET status=? WHERE zone_id=? AND applicant_user_id=?',
			[approve ? 'approved' : 'rejected', zoneId, applicant]);

		if (approve) {
			try {
				const guild = interaction.guild;
				const member = await guild.members.fetch(applicant);
				await member.roles.add(zone.role_member_id);
			} catch {}
		}

		try {
			await interaction.update({ content: approve ? '✅ Demande approuvée' : '❌ Demande refusée', embeds: [], components: [] });
		} catch {
			await interaction.reply({ content: approve ? '✅ Demande approuvée' : '❌ Demande refusée', ephemeral: true });
		}
	}
}

module.exports = { PolicyService };
