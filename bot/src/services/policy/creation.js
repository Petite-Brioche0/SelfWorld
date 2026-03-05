const {
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	EmbedBuilder,
	MessageFlags,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle
} = require('discord.js');
const { validateZoneName, validateZoneDescription, sanitizeName } = require('../../utils/validation');

// --- Module-local helpers (not exported on prototype) ---

const POLICY_VALUES = new Set(['open', 'ask', 'closed']);

function _hydrateCreationRequest(row) {
	if (!row) return null;
	const request = { ...row };
	if (request.extras) {
		if (typeof request.extras === 'string') {
			try {
				request.extras = JSON.parse(request.extras);
			} catch {
				request.extras = {};
			}
		}
	} else {
		request.extras = {};
	}
	if (request.validation_errors) {
		try {
			const parsed = JSON.parse(request.validation_errors);
			request.validation_errors = Array.isArray(parsed) ? parsed : [];
		} catch {
			request.validation_errors = [];
		}
	} else {
		request.validation_errors = [];
	}
	return request;
}

async function _getCreationRequest(db, requestId) {
	const [rows] = await db.query('SELECT * FROM zone_creation_requests WHERE id = ?', [requestId]);
	if (!rows?.length) return null;
	return _hydrateCreationRequest(rows[0]);
}

async function _getRequestsChannelId(db, guildId) {
	if (!guildId) return null;
	const [rows] = await db.query('SELECT requests_channel_id FROM settings WHERE guild_id = ?', [guildId]);
	const configured = rows?.[0]?.requests_channel_id;
	return configured || process.env.ZONE_REQUESTS_CHANNEL_ID || null;
}

function _formatValidationErrors(errors = []) {
	if (!Array.isArray(errors) || !errors.length) return null;
	return errors.map((err) => `• ${err}`).join('\n');
}

function _buildCreationRequestComponents(requestId) {
	return [
		new ActionRowBuilder().addComponents(
			new ButtonBuilder()
				.setCustomId(`req:deny:${requestId}`)
				.setLabel('Refuser')
				.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
				.setCustomId(`req:editaccept:${requestId}`)
				.setLabel('Modifier & Accepter')
				.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
				.setCustomId(`req:accept:${requestId}`)
				.setLabel('Accepter')
				.setStyle(ButtonStyle.Success)
		)
	];
}

function _buildCreationRequestEmbed(svc, request) {
	const embed = new EmbedBuilder()
		.setTitle('Nouvelle demande de zone')
		.setColor(0x5865f2)
		.addFields(
			{ name: 'Nom proposé', value: request.name || '—', inline: false },
			{
				name: 'Demandeur',
				value: `<@${request.user_id}> (${request.user_id})`,
				inline: false
			},
			{
				name: 'Politique souhaitée',
				value: svc._policyLabel(request.policy || 'ask'),
				inline: false
			}
		)
		.setTimestamp(new Date());

	const description = request.description ? request.description.slice(0, 1000) : '—';
	embed.addFields({ name: 'Description', value: description, inline: false });

	const extras = request.extras || {};
	if (extras.needs) {
		embed.addFields({ name: 'Besoins / notes', value: extras.needs.slice(0, 1000), inline: false });
	}
	if (extras.tags?.length) {
		embed.addFields({ name: 'Tags', value: extras.tags.join(', ').slice(0, 1000), inline: false });
	}

	const formattedErrors = _formatValidationErrors(request.validation_errors);
	if (formattedErrors) {
		embed.addFields({ name: '⚠️ À corriger', value: formattedErrors, inline: false });
	}

	return embed;
}

async function _disableCreationRequestMessage(svc, request, statusLabel) {
	if (!request?.message_channel_id || !request?.message_id) return;
	try {
		const channel = await svc.client.channels.fetch(request.message_channel_id).catch(() => null);
		if (!channel?.messages?.fetch) return;
		const message = await channel.messages.fetch(request.message_id).catch(() => null);
		if (!message) return;

		const components = [];
		for (const row of message.components) {
			const newRow = new ActionRowBuilder();
			for (const component of row.components) {
				try {
					const cloned = ButtonBuilder.from(component);
					cloned.setDisabled(true);
					newRow.addComponents(cloned);
				} catch (err) {
					svc.logger?.debug({ err }, 'Failed to clone button component for disabling');
				}
			}
			if (newRow.components.length) {
				components.push(newRow);
			}
		}

		const embed = _buildCreationRequestEmbed(svc, {
			...request,
			validation_errors: request.validation_errors || []
		});
		if (statusLabel) {
			embed.setFooter({ text: statusLabel });
		}

		await message.edit({ embeds: [embed], components }).catch((err) => {
			if (err?.code === 10008) return;
			svc.logger?.warn({ err, messageId: message?.id, requestId: request?.id }, 'Failed to edit creation request message');
		});
	} catch (err) {
		svc.logger?.warn({ err, requestId: request?.id }, 'Failed to update creation request message');
	}
}

async function _createZoneFromRequest(svc, request, { actorId, name, description, policy }) {
	const guild = await svc.client.guilds.fetch(request.guild_id).catch(() => null);
	if (!guild) throw new Error('Serveur introuvable');
	const zoneService = svc.services?.zone;
	if (!zoneService?.createZone) throw new Error('Service de zone indisponible');

	const finalName = sanitizeName(name || request.name).slice(0, 64);
	const finalDescription = (description ?? request.description) || '';
	const finalPolicy = POLICY_VALUES.has(policy) ? policy : request.policy || 'ask';

	const result = await zoneService.createZone(guild, {
		name: finalName,
		ownerUserId: request.owner_user_id || request.user_id,
		policy: finalPolicy
	});

	await svc.db.query(
		`UPDATE zone_creation_requests
		 SET status = 'accepted', decided_by = ?, decided_at = NOW(), zone_id = ?, name = ?, description = ?, policy = ?, validation_errors = NULL
		 WHERE id = ?`,
		[actorId, result.zoneId || null, finalName, finalDescription, finalPolicy, request.id]
	);

	const updated = {
		...request,
		status: 'accepted',
		name: finalName,
		description: finalDescription,
		policy: finalPolicy,
		validation_errors: [],
		message_channel_id: request.message_channel_id,
		message_id: request.message_id
	};
	await _disableCreationRequestMessage(svc, updated, 'Acceptée');
	await svc._dmUser(request.user_id, {
		content: `🎉 Ta zone **${finalName}** a été créée !`
	});

	return result;
}

// --- Exported methods (mixed into PolicyService.prototype) ---

module.exports = {
	// PUBLIC: Handle zone creation request modal submission
	async handleZoneRequestModal(interaction) {
		await this.ensureSchema();

		const payload = this._extractCreationRequestPayload(interaction);
		const guildId = interaction.guildId || payload.guildId || null;
		if (!guildId) {
			const content = 'Serveur introuvable pour cette demande.';
			if (interaction.replied || interaction.deferred) {
				await interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to send no-guild follow-up');
				});
			} else {
				await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to send no-guild reply');
				});
			}
			return true;
		}

		const replyOpts = interaction.inGuild?.() ? { flags: MessageFlags.Ephemeral } : {};
		if (!interaction.deferred && !interaction.replied) {
			await interaction.deferReply(replyOpts).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer reply');
			});
		}

		try {
			const nameResult = validateZoneName(payload.name);
			const descResult = validateZoneDescription(payload.description);
			const errors = [...nameResult.errors, ...descResult.errors];

			const conflict = await this._zoneNameExists(guildId, nameResult.value);
			if (conflict) {
				errors.push('Nom indisponible : une zone existe déjà avec ce nom.');
			}

			const [recentRows] = await this.db.query(
				"SELECT COUNT(*) AS n FROM zone_creation_requests WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)",
				[interaction.user.id]
			);
			if (Number(recentRows?.[0]?.n || 0) >= 5) {
				await interaction.editReply({
					content: '⚠️ **Limite atteinte**\n\nTu as déjà soumis trop de demandes récemment. Réessaye dans quelques heures.'
				}).catch(() => {});
				return true;
			}

			const extras = payload.extras || {};
			if (typeof extras.needs === 'string') {
				extras.needs = extras.needs.trim().slice(0, 1000);
			}
			if (Array.isArray(extras.tags)) {
				extras.tags = extras.tags.map((tag) => tag.trim()).filter(Boolean).slice(0, 8);
			}
			const [res] = await this.db.query(
				'INSERT INTO zone_creation_requests (guild_id, user_id, owner_user_id, name, description, extras, policy, validation_errors) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
				[
					guildId,
					interaction.user.id,
					interaction.user.id,
					nameResult.value,
					descResult.value,
					JSON.stringify(extras || {}),
					'ask',
					errors.length ? JSON.stringify(errors) : null
				]
			);

			const requestId = res.insertId;
			const request = _hydrateCreationRequest({
				id: requestId,
				guild_id: guildId,
				user_id: interaction.user.id,
				owner_user_id: interaction.user.id,
				name: nameResult.value,
				description: descResult.value,
				extras: JSON.stringify(extras || {}),
				policy: 'ask',
				status: 'pending',
				validation_errors: errors.length ? JSON.stringify(errors) : null
			});

			const delivered = await this._deliverCreationRequest(request);
			if (!delivered) {
				this.logger?.warn({ requestId }, 'Zone creation request could not be delivered');
			}

			const ack = errors.length
				? '✅ Demande envoyée (quelques ajustements seront nécessaires avant validation).'
				: '✅ Merci ! Ta demande a bien été transmise aux modérateurs.';
			await interaction.editReply({ content: ack }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to send creation request acknowledgment');
			});
		} catch (err) {
			this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to register zone creation request');
			await interaction
				.editReply({ content: "❌ Impossible d'enregistrer ta demande pour le moment." })
				.catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to send creation error reply');
				});
		}

		return true;
	},

	// PUBLIC: Handle creation request button clicks (accept/deny/editaccept)
	async handleCreationRequestButton(interaction) {
		await this.ensureSchema();

		const parts = interaction.customId.split(':');
		if (parts.length < 3) {
			await interaction.reply({ content: 'Action invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid action reply');
			});
			return true;
		}

		const action = parts[1];
		const requestId = Number(parts[2]);
		if (!requestId || !['accept', 'deny', 'editaccept'].includes(action)) {
			await interaction.reply({ content: 'Action invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid action reply');
			});
			return true;
		}

		const ownerId =
			this.client?.context?.config?.ownerUserId ||
			process.env.OWNER_ID ||
			process.env.OWNER_USER_ID;

		if (!ownerId || String(interaction.user.id) !== String(ownerId)) {
			await interaction.reply({ content: "Seul l'owner peut traiter cette demande.", flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to send owner-only reply');
			});
			return true;
		}

		const request = await _getCreationRequest(this.db, requestId);
		if (!request) {
			await interaction.reply({ content: 'Demande introuvable ou déjà traitée.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to send request-not-found reply');
			});
			return true;
		}

		if (action === 'editaccept') {
			const modal = new ModalBuilder().setCustomId(`req:editaccept:${request.id}`).setTitle('Modifier & Accepter');
			modal.addComponents(
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('requestName')
						.setLabel('Nom de la zone')
						.setStyle(TextInputStyle.Short)
						.setRequired(true)
						.setMaxLength(64)
						.setValue(request.name.slice(0, 64))
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('requestDescription')
						.setLabel('Description / objectif')
						.setStyle(TextInputStyle.Paragraph)
						.setRequired(true)
						.setMaxLength(500)
						.setValue((request.description || '').slice(0, 500))
				),
				new ActionRowBuilder().addComponents(
					new TextInputBuilder()
						.setCustomId('requestPolicy')
						.setLabel('Politique (fermé / sur demande / ouvert)')
						.setStyle(TextInputStyle.Short)
						.setRequired(true)
						.setMaxLength(20)
						.setValue(this._policyLabel(request.policy || 'ask'))
				)
			);
			await interaction.showModal(modal);
			return true;
		}

		await interaction.deferUpdate().catch((err) => {
			if (err?.code === 10062 || err?.rawError?.code === 10062) return;
			this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to defer update');
		});

		if (request.status !== 'pending') {
			await interaction
				.followUp({ content: 'Cette demande est déjà traitée.', flags: MessageFlags.Ephemeral })
				.catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to send already-processed follow-up');
				});
			return true;
		}

		if (action === 'deny') {
			try {
				await this.db.query(
					"UPDATE zone_creation_requests SET status = 'denied', decided_by = ?, decided_at = NOW() WHERE id = ? AND status = 'pending'",
					[interaction.user.id, request.id]
				);
				const updated = { ...request, status: 'denied', validation_errors: [] };
				await _disableCreationRequestMessage(this, updated, 'Refusée');
				await this._dmUser(request.user_id, {
					content: `Ta demande de zone **${request.name}** a été refusée.`
				});
				await interaction
					.followUp({ content: 'Demande refusée.', flags: MessageFlags.Ephemeral })
					.catch((err) => {
						if (err?.code === 10062 || err?.rawError?.code === 10062) return;
						this.logger?.warn({ err, userId: interaction.user.id, requestId: request.id }, 'Failed to send deny confirmation');
					});
			} catch (err) {
				this.logger?.warn({ err, requestId: request.id }, 'Failed to deny creation request');
				await interaction
					.followUp({ content: 'Impossible de refuser la demande pour le moment.', flags: MessageFlags.Ephemeral })
					.catch((err) => {
						if (err?.code === 10062 || err?.rawError?.code === 10062) return;
						this.logger?.warn({ err, userId: interaction.user.id, requestId: request.id }, 'Failed to send deny error follow-up');
					});
			}
			return true;
		}

		if (request.validation_errors?.length) {
			await interaction
				.followUp({
					content: "Impossible d'accepter : corrige les éléments signalés via « Modifier & Accepter ». ",
					flags: MessageFlags.Ephemeral
				})
				.catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.logger?.warn({ err, userId: interaction.user.id, requestId: request.id }, 'Failed to send validation error follow-up');
				});
			return true;
		}

		try {
			await _createZoneFromRequest(this, request, {
				actorId: interaction.user.id,
				policy: request.policy
			});
			await interaction
				.followUp({ content: 'Zone créée et demande acceptée.', flags: MessageFlags.Ephemeral })
				.catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.logger?.warn({ err, userId: interaction.user.id, requestId: request.id }, 'Failed to send accept confirmation');
				});
		} catch (err) {
			this.logger?.warn({ err, requestId: request.id }, 'Failed to accept creation request');
			await interaction
				.followUp({
					content: `Impossible de créer la zone : ${err?.message || err}`,
					flags: MessageFlags.Ephemeral
				})
				.catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.logger?.warn({ err, userId: interaction.user.id, requestId: request.id }, 'Failed to send accept error follow-up');
				});
		}

		return true;
	},

	// PUBLIC: Handle creation request edit modal submission
	async handleCreationRequestModal(interaction) {
		await this.ensureSchema();

		const parts = interaction.customId.split(':');
		if (parts.length < 3) {
			await interaction.reply({ content: 'Action invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid modal action reply');
			});
			return true;
		}

		const requestId = Number(parts[2]);
		if (!requestId) {
			await interaction.reply({ content: 'Demande invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid request modal reply');
			});
			return true;
		}

		const ownerId =
			this.client?.context?.config?.ownerUserId ||
			process.env.OWNER_ID ||
			process.env.OWNER_USER_ID;

		if (!ownerId || String(interaction.user.id) !== String(ownerId)) {
			await interaction.reply({ content: "Seul l'owner peut modifier la demande.", flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to send owner-only modal reply');
			});
			return true;
		}

		if (!interaction.deferred && !interaction.replied) {
			await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to defer modal reply');
			});
		}

		const request = await _getCreationRequest(this.db, requestId);
		if (!request || request.status !== 'pending') {
			await interaction.editReply({ content: 'Demande introuvable ou déjà traitée.' }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to send modal request-not-found reply');
			});
			return true;
		}

		const nameInput = interaction.fields.getTextInputValue('requestName') || '';
		const descInput = interaction.fields.getTextInputValue('requestDescription') || '';
		const policyInput = interaction.fields.getTextInputValue('requestPolicy') || '';

		const nameResult = validateZoneName(nameInput);
		const descResult = validateZoneDescription(descInput);
		const normalizedPolicy = this._normalizePolicyInput(policyInput);

		const issues = [...nameResult.errors, ...descResult.errors];
		if (!normalizedPolicy) {
			issues.push('Politique invalide : choisis fermé, sur demande ou ouvert.');
		}

		if (nameResult.value !== request.name) {
			const conflict = await this._zoneNameExists(request.guild_id, nameResult.value);
			if (conflict) {
				issues.push('Nom indisponible : une zone existe déjà avec ce nom.');
			}
		}

		if (issues.length) {
			await interaction.editReply({ content: `❌ ${issues.join('\n')}` }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to send modal validation issues');
			});
			return true;
		}

		try {
			await _createZoneFromRequest(this, request, {
				actorId: interaction.user.id,
				name: nameResult.value,
				description: descResult.value,
				policy: normalizedPolicy
			});
			await interaction.editReply({ content: 'Zone créée et demande acceptée.' }).catch((err) => {
				if (err?.code === 10062 || err?.rawError?.code === 10062) return;
				this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to send modal accept confirmation');
			});
		} catch (err) {
			this.logger?.warn({ err, requestId }, 'Failed to accept request via modal');
			await interaction
				.editReply({ content: `Impossible de créer la zone : ${err?.message || err}` })
				.catch((err) => {
					if (err?.code === 10062 || err?.rawError?.code === 10062) return;
					this.logger?.warn({ err, userId: interaction.user.id, requestId }, 'Failed to send modal accept error');
				});
		}

		return true;
	},

	// Internal: Extract creation request payload from modal interaction
	_extractCreationRequestPayload(interaction) {
		const customId = interaction.customId || '';
		if (customId === 'zone:request:create') {
			return {
				name: interaction.fields.getTextInputValue('zoneName') || '',
				description: interaction.fields.getTextInputValue('zonePitch') || '',
				extras: {
					needs: interaction.fields.getTextInputValue('zoneNeeds') || ''
				},
				guildId: interaction.guildId || null
			};
		}

		if (customId.startsWith('welcome:request:modal')) {
			const rawTags = interaction.fields.getTextInputValue('welcomeRequestTags') || '';
			const tags = rawTags
				.split(',')
				.map((entry) => entry.trim())
				.filter((entry) => entry.length)
				.slice(0, 8);
			const parts = customId.split(':');
			const guildIdFromId = parts.length >= 4 ? parts[3] : null;
			return {
				name: interaction.fields.getTextInputValue('welcomeRequestName') || '',
				description: interaction.fields.getTextInputValue('welcomeRequestPitch') || '',
				extras: { tags },
				guildId: guildIdFromId || interaction.guildId || null
			};
		}

		return {
			name: interaction.fields.getTextInputValue('zoneName') || '',
			description: interaction.fields.getTextInputValue('zonePitch') || '',
			extras: {},
			guildId: interaction.guildId || null
		};
	},

	// Internal: Deliver creation request to requests channel or owner DM
	async _deliverCreationRequest(request) {
		const components = _buildCreationRequestComponents(request.id);
		const embed = _buildCreationRequestEmbed(this, request);
		const ownerId =
			this.client?.context?.config?.ownerUserId ||
			process.env.OWNER_ID ||
			process.env.OWNER_USER_ID;

		let message = null;

		if (request.guild_id) {
			const channelId = await _getRequestsChannelId(this.db, request.guild_id);
			if (channelId) {
				try {
					const channel = await this.client.channels.fetch(channelId);
					if (channel?.isTextBased?.()) {
						const content = ownerId ? `<@${ownerId}>` : null;
						message = await channel
							.send({ content: content || undefined, embeds: [embed], components })
							.catch(() => null);
					}
				} catch (err) {
					this.logger?.warn({ err, channelId }, 'Failed to forward creation request to channel');
				}
			}
		}

		if (!message && ownerId) {
			try {
				const ownerUser = await this.client.users.fetch(ownerId);
				message = await ownerUser.send({ embeds: [embed], components }).catch(() => null);
			} catch (err) {
				this.logger?.warn({ err, ownerId }, 'Failed to DM owner for zone request');
			}
		}

		if (message) {
			await this.db
				.query('UPDATE zone_creation_requests SET message_channel_id = ?, message_id = ? WHERE id = ?', [
					message.channelId,
					message.id,
					request.id
				])
				.catch((err) => {
					this.logger?.warn({ err, requestId: request.id }, 'Failed to update creation request message IDs');
				});
			request.message_channel_id = message.channelId;
			request.message_id = message.id;
			return true;
		}

		return false;
	},
};
