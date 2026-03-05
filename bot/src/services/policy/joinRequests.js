const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
} = require('discord.js');

// ---------------------------------------------------------------------------
// Local helper functions (not exported on the prototype)
// ---------------------------------------------------------------------------

function _sanitizeJoinNote(value) {
	if (!value) return null;
	const note = String(value).trim();
	if (!note.length) return null;
	return note.slice(0, 1000);
}

function _buildJoinRequestEmbed(svc, zone, request, applicantMember, context = {}) {
	const embed = new EmbedBuilder()
		.setTitle(`Demande d'entrée — ${zone.name}`)
		.setDescription(`<@${request.user_id}> souhaite rejoindre la zone.`)
		.setColor(zone.profile_color || 0x5865f2)
		.addFields({ name: 'Membre', value: `<@${request.user_id}> (${request.user_id})`, inline: false })
		.setTimestamp(new Date());

	const joinedValue = applicantMember?.joinedAt
		? `<t:${Math.floor(applicantMember.joinedAt.getTime() / 1000)}:D>`
		: '—';
	const createdValue = applicantMember?.user?.createdAt
		? `<t:${Math.floor(applicantMember.user.createdAt.getTime() / 1000)}:D>`
		: '—';

	embed.addFields(
		{ name: 'Sur le serveur depuis', value: joinedValue, inline: true },
		{ name: 'Compte créé', value: createdValue, inline: true }
	);

	const avatar =
		applicantMember?.displayAvatarURL?.({ size: 128 }) ||
		applicantMember?.user?.displayAvatarURL?.({ size: 128 }) ||
		svc.client?.users?.cache?.get(request.user_id)?.displayAvatarURL?.({ size: 128 }) ||
		null;
	if (avatar) {
		embed.setThumbnail(avatar);
	}

	if (request.note) {
		embed.addFields({ name: 'Motivation', value: request.note, inline: false });
	}

	if (context?.source) {
		embed.setFooter({ text: `Source : ${context.source}` });
	}

	return embed;
}

async function _resolveRequestChannel(svc, zone, ensureInterview = true) {
	const approver = zone.ask_approver_mode || 'owner';
	if (approver === 'owner') {
		return ensureInterview ? svc._ensureInterviewRoom(zone) : svc._findInterviewRoom(zone);
	}
	if (!zone.text_reception_id) return null;
	return svc.client.channels.fetch(zone.text_reception_id).catch(() => null);
}

// ---------------------------------------------------------------------------
// Exported mixin methods — merged into PolicyService.prototype
// ---------------------------------------------------------------------------

module.exports = {
	async handleApprovalButton(interaction) {
		const parts = interaction.customId.split(':');
		if (parts.length < 4) {
			await interaction.reply({
				content: 'Action invalide.',
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid action reply');
			});
			return true;
		}

		const action = parts[1];
		const zoneId = Number(parts[2]);
		const targetUserId = parts[3];

		if (!zoneId || !targetUserId || !['approve', 'reject'].includes(action)) {
			await interaction.reply({
				content: 'Action invalide.',
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId, targetUserId }, 'Failed to send invalid action reply');
			});
			return true;
		}

		await this.ensureSchema();
		const zone = await this._getZone(zoneId);
		if (!zone) {
			await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send zone not found reply');
			});
			return true;
		}

		const guild = interaction.guild ?? (await this.client.guilds.fetch(zone.guild_id).catch(() => null));
		const actorMember =
			interaction.member ?? (guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null);

		if (!(await this._canModerateRequests(zone, interaction.user.id, actorMember))) {
			await interaction.reply({
				content: 'Tu ne peux pas traiter cette demande.',
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId: zone.id }, 'Failed to send permission denied reply');
			});
			return true;
		}

		const [rows] = await this.db.query(
			"SELECT * FROM zone_join_requests WHERE zone_id = ? AND user_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
			[zoneId, targetUserId]
		);
		const request = rows?.[0];
		if (!request) {
			await interaction.reply({
				content: 'Cette demande a déjà été traitée.',
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send request already processed reply');
			});
			return true;
		}

		try {
			await interaction.deferUpdate();
		} catch (err) {
			if (err?.code === 10062 || err?.rawError?.code === 10062) return;
			this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer update');
		}

		const approved = action === 'approve';
		let statusUpdate = 'declined';
		if (approved) statusUpdate = 'accepted';

		try {
			const [result] = await this.db.query(
				"UPDATE zone_join_requests SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ? AND status = 'pending'",
				[statusUpdate, interaction.user.id, request.id]
			);

			if (!result?.affectedRows) {
				await interaction.followUp({
					content: 'Cette demande a déjà été traitée.',
					flags: MessageFlags.Ephemeral
				}).catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to send follow-up');
				});
				return true;
			}

			if (approved) {
				await this._grantZoneMembership(zone, targetUserId);
				await this._dmUser(targetUserId, {
					content: `✅ Ta demande pour **${zone.name}** a été acceptée !`
				});
			} else {
				await this._dmUser(targetUserId, {
					content: `❌ Ta demande pour **${zone.name}** a été refusée.`
				});
			}

			await this._refreshPanel(zone.id);
			await this._disableInteractionRow(interaction.message);

			await interaction.followUp({
				content: approved
					? '✅ Demande acceptée. Le membre va être notifié.'
					: 'Demande refusée.',
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send approval follow-up');
			});

			this.logger?.info(
				{
					zoneId,
					actorId: interaction.user.id,
					targetUserId,
					action: approved ? 'approve' : 'reject'
				},
				'Join request processed'
			);
		} catch (err) {
			this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to handle approval button');
			await interaction.followUp({
				content: `Impossible de traiter la demande : ${err.message || err}`,
				flags: MessageFlags.Ephemeral
			}).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send error follow-up');
			});
		}

		return true;
	},

	async isUserMember(zoneId, userId) {
		const [rows] = await this.db.query(
			'SELECT 1 FROM zone_members WHERE zone_id = ? AND user_id = ? LIMIT 1',
			[zoneId, userId]
		);
		return Boolean(rows?.length);
	},

	async createJoinRequest(zoneId, userId, options = {}) {
		await this.ensureSchema();
		const zone = await this._getZone(zoneId);
		if (!zone) throw new Error('Zone introuvable');
		if (zone.policy !== 'ask') throw new Error('Zone indisponible pour des demandes.');
		if (await this.isUserMember(zoneId, userId)) {
			return { status: 'already-member', zone };
		}

		const note = _sanitizeJoinNote(options.note);

		const [existing] = await this.db.query(
			"SELECT * FROM zone_join_requests WHERE zone_id = ? AND user_id = ? AND status = 'pending' ORDER BY id DESC",
			[zoneId, userId]
		);
		if (existing?.length) {
			return { status: 'already-requested', zone, request: existing[0] };
		}

		const [result] = await this.db.query(
			'INSERT INTO zone_join_requests (zone_id, user_id, note) VALUES (?, ?, ?)',
			[zoneId, userId, note]
		);

		const request = {
			id: result.insertId,
			zone_id: zoneId,
			user_id: userId,
			status: 'pending',
			created_at: new Date(),
			note
		};

		this.logger?.info({ zoneId, userId }, 'Join request created');

		return { status: 'created', zone, request };
	},

	async postJoinRequestCard(zone, request, applicantMember = null, context = {}) {
		if (!zone?.id || !request?.id) return null;

		await this.ensureSchema();

		const channel = await _resolveRequestChannel(this, zone, context.ensureInterview !== false);
		if (!channel) return null;

		const embed = _buildJoinRequestEmbed(this, zone, request, applicantMember, context);

		const approveId = `zone:approve:${zone.id}:${request.user_id}`;
		const rejectId = `zone:reject:${zone.id}:${request.user_id}`;

		const row = new ActionRowBuilder().addComponents(
			new ButtonBuilder().setCustomId(approveId).setLabel('Accepter').setStyle(ButtonStyle.Success),
			new ButtonBuilder().setCustomId(rejectId).setLabel('Refuser').setStyle(ButtonStyle.Danger)
		);

		const message = await channel.send({ embeds: [embed], components: [row] });

		await this.db.query(
			'UPDATE zone_join_requests SET message_channel_id = ?, message_id = ? WHERE id = ?',
			[message.channelId, message.id, request.id]
		);

		this.logger?.info({ zoneId: zone.id, requestId: request.id, channelId: message.channelId }, 'Join request card posted');

		return message;
	},

	async grantMembership(zoneId, userId) {
		await this.ensureSchema();
		const zone = await this._getZone(zoneId);
		if (!zone) throw new Error('Zone introuvable');
		await this._grantZoneMembership(zone, userId);
		return zone;
	},
};
