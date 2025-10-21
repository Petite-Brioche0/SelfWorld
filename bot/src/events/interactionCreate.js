const {
InteractionType,
MessageFlags,
DiscordAPIError,
ModalBuilder,
TextInputBuilder,
TextInputStyle,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle,
PermissionFlagsBits
} = require('discord.js');

const DEFAULT_THROTTLE_SECONDS = 4;

function isUnknownInteractionError(error) {
        if (!error) return false;
        if (error instanceof DiscordAPIError && error.code === 10062) return true;
        if (error?.code === 10062 || error?.rawError?.code === 10062) return true;
        return false;
}

function resolveCooldown(interaction) {
        if (!interaction) return null;

       if (interaction.isModalSubmit()) {
               const id = interaction.customId || '';
               if (id.startsWith('zone:request:') || id === 'welcome:request:modal') {
                       return { key: 'zone.request.create', seconds: 600 };
               }
               if (id.startsWith('req:editaccept:')) {
                       return { key: 'zone.request.review', seconds: 8 };
               }
               if (id.startsWith('panel:role:create')) {
                       return { key: 'zone.role.create', seconds: 60 };
               }
               if (id.startsWith('panel:ch:create')) {
                       return { key: 'panel.channels.edit', seconds: 25 };
               }
               if (id.startsWith('temp:panel:')) {
                       return { key: 'temp.panel.invite', seconds: 12 };
               }
               if (id.startsWith('panel:')) {
                       return { key: 'panel.modal', seconds: 10 };
               }
               return { key: 'modal.generic', seconds: DEFAULT_THROTTLE_SECONDS };
       }

		if (interaction.isButton()) {
			const id = interaction.customId || '';
			if (id === 'temp:fromAnon:create:closed' || id === 'temp:fromAnon:create:open') {
				return { key: 'anon.temp.create', seconds: 10 };
			}
			if (id.startsWith('temp:open:join:') || id.startsWith('temp:open:spectate:')) {
				return { key: 'anon.temp.participate', seconds: 6 };
			}
			if (id.startsWith('temp:panel:')) {
				return { key: 'temp.panel.button', seconds: 6 };
			}
			if (id.startsWith('temp:join:') || id.startsWith('temp:spectate:') || id.startsWith('temp:leave:')) {
				return { key: 'temp.membership', seconds: 6 };
			}
			if (id.startsWith('temp:vote:')) {
				return { key: 'temp.vote', seconds: 10 };
			}
			if (id.startsWith('panel:refresh:')) {
				return { key: 'panel.refresh', seconds: 10 };
			}
			if (id.startsWith('panel:role:')) {
				return { key: 'panel.roles.edit', seconds: 25 };
			}
			if (id.startsWith('panel:ch:')) {
				return { key: 'panel.channels.edit', seconds: 25 };
			}
			if (id.startsWith('panel:member:')) {
				return { key: 'panel.members.manage', seconds: 15 };
			}
			if (id.startsWith('panel:policy:')) {
				return { key: 'panel.policy', seconds: 12 };
			}
			if (id.startsWith('req:')) {
				return { key: 'zone.request.review', seconds: 8 };
			}
			if (id.startsWith('zone:approve:') || id.startsWith('zone:reject:')) {
				return { key: 'zone.request.review', seconds: 8 };
			}
			if (id.startsWith('welcome:')) {
				return { key: 'welcome.flow', seconds: 5 };
			}
			return { key: 'button.generic', seconds: DEFAULT_THROTTLE_SECONDS };
		}

		if (interaction.isStringSelectMenu()) {
			const id = interaction.customId || '';
			if (id === 'temp:fromAnon:closed:select') {
				return { key: 'anon.temp.select', seconds: 12 };
			}
			if (id.startsWith('panel:policy:')) {
				return { key: 'panel.policy', seconds: 10 };
			}
			if (id.startsWith('panel:')) {
				return { key: 'panel.select', seconds: 6 };
			}
			if (id.startsWith('admin:zonecreate:')) {
				return { key: 'zone.create.policy', seconds: 20 };
			}
			return { key: 'select.generic', seconds: DEFAULT_THROTTLE_SECONDS };
		}

		return null;
		}

		async function safeReply(interaction, payload) {
			if (!interaction) return;
			try {
				if (!interaction.deferred && !interaction.replied) {
					await interaction.reply(payload);
				} else {
					await interaction.followUp(payload);
				}
			} catch (err) {
				if (!isUnknownInteractionError(err)) throw err;
			}
		}

		async function ensureDeferred(interaction, payload) {
			if (!interaction) return;
			if (interaction.deferred || interaction.replied) return;
			try {
				await interaction.deferReply(payload);
			} catch (err) {
				if (!isUnknownInteractionError(err)) throw err;
			}
		}

		function formatParisDate(date) {
			if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
			const dtf = new Intl.DateTimeFormat('fr-FR', {
				timeZone: 'Europe/Paris',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				hour12: false
			});
			return dtf.format(date);
		}

		function buildPreviewButtons(kind, token, options = {}) {
			const confirmLabel = options?.confirmLabel || (kind === 'event' ? 'Publier' : 'Diffuser');
			return new ActionRowBuilder().addComponents(
			new ButtonBuilder()
			.setCustomId(`${kind}:preview:cancel:${token}`)
			.setLabel('Annuler')
			.setStyle(ButtonStyle.Danger),
			new ButtonBuilder()
			.setCustomId(`${kind}:preview:edit:${token}`)
			.setLabel('Modifier')
			.setStyle(ButtonStyle.Secondary),
			new ButtonBuilder()
			.setCustomId(`${kind}:preview:confirm:${token}`)
			.setLabel(confirmLabel)
			.setStyle(ButtonStyle.Success),
			new ButtonBuilder()
			.setCustomId(`${kind}:preview:schedule:${token}`)
			.setLabel('Programmer')
			.setStyle(ButtonStyle.Primary)
			);
		}

		async function replyWithPreview(interaction, services, kind, draft, token) {
			const eventService = services?.event;
			if (!eventService || !draft) {
				await interaction.reply({ content: 'Service indisponible.', flags: MessageFlags.Ephemeral }).catch(() => {});
				return;
			}
			const payload = draft.payload || {};
			const scheduledIso = payload?.scheduledAt || null;
			const scheduledAt = scheduledIso ? new Date(scheduledIso) : null;
			const preview = eventService.announceToAllZonesPreview(payload, {
				state: { scheduledAt, maxParticipants: payload?.maxParticipants }
			});
			const components = [];
			if (Array.isArray(preview?.components) && preview.components.length) {
				components.push(...preview.components);
			}
			components.push(buildPreviewButtons(kind, token, { confirmLabel: kind === 'event' ? 'Publier' : 'Diffuser' }));
			const parts = [];
			if (scheduledAt && !Number.isNaN(scheduledAt.getTime())) {
				const formatted = formatParisDate(scheduledAt);
				if (formatted) parts.push(`🗓️ Diffusion programmée le ${formatted}`);
			}
			const content = parts.length ? parts.join('\n') : null;
			await interaction
			.reply({ content, embeds: preview?.embeds || [], components, flags: MessageFlags.Ephemeral })
			.catch((err) => {
				if (!isUnknownInteractionError(err)) throw err;
			});
		}

		module.exports = {
			name: 'interactionCreate',
			once: false,
			async execute(interaction, client) {
				const ownerId =
				client?.context?.config?.ownerUserId ||
				process.env.OWNER_ID ||
				process.env.OWNER_USER_ID;

				const commands = client.commands;
				const context = client.contextMenus;
				const services = client.context.services;

				const throttleService = services?.throttle || null;
				const isOwner = ownerId && interaction.user.id === String(ownerId);
				const cooldown = !isOwner ? resolveCooldown(interaction) : null;
				let throttleKey = null;

				try {
					if (cooldown && throttleService) {
						const result = await throttleService.begin(interaction.user.id, cooldown.key, cooldown.seconds);
						if (!result.ok) {
							await safeReply(interaction, {
								content: `⏳ Calme :) Réessaie dans ${result.retrySec}s.`,
								flags: MessageFlags.Ephemeral
							});
							return;
						}
						throttleKey = cooldown.key;
					}

					if (interaction.isChatInputCommand()) {
						const cmd = commands.get(interaction.commandName);
						if (!cmd) return;
						if (cmd.ownerOnly && interaction.user.id !== ownerId) {
							await safeReply(interaction, {
								content: 'Commande réservée à l’Owner.',
								flags: MessageFlags.Ephemeral
							});
							return;
						}
						await ensureDeferred(interaction, { flags: MessageFlags.Ephemeral });
						await cmd.execute(interaction, client.context);
						return;
					}

					if (interaction.isContextMenuCommand()) {
						const cmd = context.get(interaction.commandName);
						if (!cmd) return;
						if (cmd.ownerOnly && interaction.user.id !== ownerId) {
							await safeReply(interaction, {
								content: 'Commande réservée à l’Owner.',
								flags: MessageFlags.Ephemeral
							});
							return;
						}
						await ensureDeferred(interaction, { flags: MessageFlags.Ephemeral });
						await cmd.execute(interaction, client.context);
						return;
					}

					const customId = 'customId' in interaction ? interaction.customId || '' : '';
					const isReception = services.zone?.isReceptionChannel?.(interaction.channelId) === true;
					if (customId.startsWith('welcome:') && isReception) {
						interaction.forceWelcomeEphemeral = true;
					}

					if (interaction.isStringSelectMenu()) {
						const id = customId;
						if (id === 'temp:fromAnon:closed:select') {
							if (!services.anon) {
								await safeReply(interaction, {
									content: 'Service indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							await services.anon.handleFromAnonClosedSelect(interaction);
							return;
						}
						if (id.startsWith('admin:zonecreate:')) {
							const cmd = commands.get('zone-create');
							if (cmd?.handlePolicySelect) {
								await cmd.handlePolicySelect(interaction, client.context);
								return;
							}
						}
						if (id.startsWith('panel:policy:set:')) {
							await services.policy.handlePolicySelect(interaction);
							return;
						}
						if (id.startsWith('panel:policy:askmode:')) {
							await services.policy.handleAskModeSelect(interaction);
							return;
						}
						if (id.startsWith('panel:policy:approver:')) {
							await services.policy.handleApproverSelect(interaction);
							return;
						}
						if (id.startsWith('panel:')) {
							await services.panel.handleSelectMenu(interaction);
							return;
						}
					}

					if (interaction.isButton()) {
						const id = customId;
						if (id === 'announce:openModal') {
							const modal = new ModalBuilder().setCustomId('announce:modal').setTitle('Annonce staff');
							const titleInput = new TextInputBuilder()
							.setCustomId('announce_title')
							.setLabel('Titre')
							.setStyle(TextInputStyle.Short)
							.setRequired(true)
							.setMaxLength(256);
							const contentInput = new TextInputBuilder()
							.setCustomId('announce_content')
							.setLabel('Contenu')
							.setStyle(TextInputStyle.Paragraph)
							.setRequired(true);
							modal.addComponents(
							new ActionRowBuilder().addComponents(titleInput),
							new ActionRowBuilder().addComponents(contentInput)
							);
							await interaction.showModal(modal);
							return;
						}
						if (id === 'event:openModal') {
							const modal = new ModalBuilder().setCustomId('event:modal').setTitle('Nouvel événement');
							const titleInput = new TextInputBuilder()
							.setCustomId('event_title')
							.setLabel('Titre')
							.setStyle(TextInputStyle.Short)
							.setRequired(true)
							.setMaxLength(120);
							const gameInput = new TextInputBuilder()
							.setCustomId('event_game')
							.setLabel('Jeu (optionnel)')
							.setStyle(TextInputStyle.Short)
							.setRequired(false);
							const contentInput = new TextInputBuilder()
							.setCustomId('event_content')
							.setLabel('Description')
							.setStyle(TextInputStyle.Paragraph)
							.setRequired(true);
							const dateInput = new TextInputBuilder()
							.setCustomId('event_date')
							.setLabel('Date prévue (JJ/MM/AAAA)')
							.setStyle(TextInputStyle.Short)
							.setRequired(false);
							const timeInput = new TextInputBuilder()
							.setCustomId('event_time')
							.setLabel('Heure (HH:MM)')
							.setStyle(TextInputStyle.Short)
							.setRequired(false);
							const durationInput = new TextInputBuilder()
							.setCustomId('event_duration')
							.setLabel('Durée prévue')
							.setStyle(TextInputStyle.Short)
							.setRequired(false);
							const maxInput = new TextInputBuilder()
							.setCustomId('event_max')
							.setLabel('Max participants')
							.setStyle(TextInputStyle.Short)
							.setRequired(false);
							const groupInput = new TextInputBuilder()
							.setCustomId('event_group')
							.setLabel('Créer un groupe temporaire ? (oui/non)')
							.setStyle(TextInputStyle.Short)
							.setRequired(false);
							modal.addComponents(
							new ActionRowBuilder().addComponents(titleInput),
							new ActionRowBuilder().addComponents(gameInput),
							new ActionRowBuilder().addComponents(contentInput),
							new ActionRowBuilder().addComponents(dateInput),
							new ActionRowBuilder().addComponents(timeInput),
							new ActionRowBuilder().addComponents(durationInput),
							new ActionRowBuilder().addComponents(maxInput),
							new ActionRowBuilder().addComponents(groupInput)
							);
							await interaction.showModal(modal);
							return;
						}
						if (id.startsWith('announce:preview:')) {
							const parts = id.split(':');
							const action = parts[2];
							const token = parts[3];
							const eventService = services.event;
							if (!token || !eventService) {
								await safeReply(interaction, {
									content: 'Prévisualisation invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							if (action === 'cancel') {
								eventService.consumeDraft(token, interaction.user.id);
								await safeReply(interaction, { content: 'Annonce annulée.', flags: MessageFlags.Ephemeral });
								return;
							}
							const draft = eventService.getDraft(token, interaction.user.id);
							if (!draft) {
								await safeReply(interaction, { content: 'Brouillon introuvable.', flags: MessageFlags.Ephemeral });
								return;
							}
							if (action === 'edit') {
								const payload = draft.payload || {};
								const modal = new ModalBuilder().setCustomId(`announce:modal:${token}`).setTitle('Modifier annonce');
								const titleInput = new TextInputBuilder()
								.setCustomId('announce_title')
								.setLabel('Titre')
								.setStyle(TextInputStyle.Short)
								.setRequired(true)
								.setMaxLength(256)
								.setValue(payload.title || '');
								const contentInput = new TextInputBuilder()
								.setCustomId('announce_content')
								.setLabel('Contenu')
								.setStyle(TextInputStyle.Paragraph)
								.setRequired(true)
								.setValue(payload.content || '');
								modal.addComponents(
								new ActionRowBuilder().addComponents(titleInput),
								new ActionRowBuilder().addComponents(contentInput)
								);
								await interaction.showModal(modal);
								return;
							}
							if (action === 'schedule') {
								const scheduledIso = draft.payload?.scheduledAt || null;
								let defaultDate = '';
								let defaultTime = '';
								if (scheduledIso) {
									const dateObj = new Date(scheduledIso);
									if (!Number.isNaN(dateObj.getTime())) {
										const formatted = formatParisDate(dateObj) || '';
										if (formatted) {
											const [d, t] = formatted.split(' ');
											defaultDate = d || '';
											defaultTime = (t || '').slice(0, 5);
										}
									}
								}
								const modal = new ModalBuilder().setCustomId(`announce:schedule:${token}`).setTitle('Programmer l’annonce');
								const dateInput = new TextInputBuilder()
								.setCustomId('schedule_date')
								.setLabel('Date (JJ/MM/AAAA)')
								.setStyle(TextInputStyle.Short)
								.setRequired(true)
								.setValue(defaultDate);
								const timeInput = new TextInputBuilder()
								.setCustomId('schedule_time')
								.setLabel('Heure (HH:MM)')
								.setStyle(TextInputStyle.Short)
								.setRequired(true)
								.setValue(defaultTime);
								modal.addComponents(
								new ActionRowBuilder().addComponents(dateInput),
								new ActionRowBuilder().addComponents(timeInput)
								);
								await interaction.showModal(modal);
								return;
							}
							if (action === 'confirm') {
								const scheduledIso = draft.payload?.scheduledAt || null;
								const scheduledAt = scheduledIso ? new Date(scheduledIso) : null;
								try {
									const result = await eventService.dispatchAnnouncement(
									draft.payload,
									scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt : null,
									{ guild: interaction.guild, authorId: interaction.user.id }
									);
									eventService.consumeDraft(token, interaction.user.id);
									let content = 'Annonce envoyée.';
									if (result?.scheduled) {
										const formatted = scheduledAt ? formatParisDate(scheduledAt) : null;
										content = formatted ? `Annonce programmée pour le ${formatted}.` : 'Annonce programmée.';
									}
									await safeReply(interaction, { content, flags: MessageFlags.Ephemeral });
								} catch (err) {
									client?.context?.logger?.error?.({ err }, 'Failed to dispatch announcement');
									await safeReply(interaction, { content: 'Erreur lors de l’envoi.', flags: MessageFlags.Ephemeral });
								}
								return;
							}
						}
						if (id.startsWith('event:preview:')) {
							const parts = id.split(':');
							const action = parts[2];
							const token = parts[3];
							const eventService = services.event;
							if (!token || !eventService) {
								await safeReply(interaction, {
									content: 'Prévisualisation invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							if (action === 'cancel') {
								eventService.consumeDraft(token, interaction.user.id);
								await safeReply(interaction, { content: 'Brouillon évènement supprimé.', flags: MessageFlags.Ephemeral });
								return;
							}
							const draft = eventService.getDraft(token, interaction.user.id);
							if (!draft) {
								await safeReply(interaction, { content: 'Brouillon introuvable.', flags: MessageFlags.Ephemeral });
								return;
							}
							if (action === 'edit') {
								const payload = draft.payload || {};
								const modal = new ModalBuilder().setCustomId(`event:modal:${token}`).setTitle('Modifier événement');
								const titleInput = new TextInputBuilder()
								.setCustomId('event_title')
								.setLabel('Titre')
								.setStyle(TextInputStyle.Short)
								.setRequired(true)
								.setMaxLength(120)
								.setValue(payload.title || '');
								const gameInput = new TextInputBuilder()
								.setCustomId('event_game')
								.setLabel('Jeu (optionnel)')
								.setStyle(TextInputStyle.Short)
								.setRequired(false)
								.setValue(payload.game || '');
								const contentInput = new TextInputBuilder()
								.setCustomId('event_content')
								.setLabel('Description')
								.setStyle(TextInputStyle.Paragraph)
								.setRequired(true)
								.setValue(payload.description || '');
								const dateInput = new TextInputBuilder()
								.setCustomId('event_date')
								.setLabel('Date prévue (JJ/MM/AAAA)')
								.setStyle(TextInputStyle.Short)
								.setRequired(false)
								.setValue(payload.expectedDate || '');
								const timeInput = new TextInputBuilder()
								.setCustomId('event_time')
								.setLabel('Heure (HH:MM)')
								.setStyle(TextInputStyle.Short)
								.setRequired(false)
								.setValue(payload.expectedTime || '');
								const durationInput = new TextInputBuilder()
								.setCustomId('event_duration')
								.setLabel('Durée prévue')
								.setStyle(TextInputStyle.Short)
								.setRequired(false)
								.setValue(payload.expectedDuration || '');
								const maxInput = new TextInputBuilder()
								.setCustomId('event_max')
								.setLabel('Max participants')
								.setStyle(TextInputStyle.Short)
								.setRequired(false)
								.setValue(payload.maxParticipants ? String(payload.maxParticipants) : '');
								const groupInput = new TextInputBuilder()
								.setCustomId('event_group')
								.setLabel('Créer un groupe temporaire ? (oui/non)')
								.setStyle(TextInputStyle.Short)
								.setRequired(false)
								.setValue(payload.createTempGroup ? 'oui' : 'non');
								modal.addComponents(
								new ActionRowBuilder().addComponents(titleInput),
								new ActionRowBuilder().addComponents(gameInput),
								new ActionRowBuilder().addComponents(contentInput),
								new ActionRowBuilder().addComponents(dateInput),
								new ActionRowBuilder().addComponents(timeInput),
								new ActionRowBuilder().addComponents(durationInput),
								new ActionRowBuilder().addComponents(maxInput),
								new ActionRowBuilder().addComponents(groupInput)
								);
								await interaction.showModal(modal);
								return;
							}
							if (action === 'schedule') {
								const scheduledIso = draft.payload?.scheduledAt || null;
								let defaultDate = '';
								let defaultTime = '';
								if (scheduledIso) {
									const dateObj = new Date(scheduledIso);
									if (!Number.isNaN(dateObj.getTime())) {
										const formatted = formatParisDate(dateObj) || '';
										if (formatted) {
											const [d, t] = formatted.split(' ');
											defaultDate = d || '';
											defaultTime = (t || '').slice(0, 5);
										}
									}
								}
								const modal = new ModalBuilder().setCustomId(`event:schedule:${token}`).setTitle('Programmer l’événement');
								const dateInput = new TextInputBuilder()
								.setCustomId('schedule_date')
								.setLabel('Date (JJ/MM/AAAA)')
								.setStyle(TextInputStyle.Short)
								.setRequired(true)
								.setValue(defaultDate);
								const timeInput = new TextInputBuilder()
								.setCustomId('schedule_time')
								.setLabel('Heure (HH:MM)')
								.setStyle(TextInputStyle.Short)
								.setRequired(true)
								.setValue(defaultTime);
								modal.addComponents(
								new ActionRowBuilder().addComponents(dateInput),
								new ActionRowBuilder().addComponents(timeInput)
								);
								await interaction.showModal(modal);
								return;
							}
							if (action === 'confirm') {
								const scheduledIso = draft.payload?.scheduledAt || null;
								const scheduledAt = scheduledIso ? new Date(scheduledIso) : null;
								try {
									const result = await eventService.dispatchAnnouncement(
									draft.payload,
									scheduledAt && !Number.isNaN(scheduledAt.getTime()) ? scheduledAt : null,
									{ guild: interaction.guild, authorId: interaction.user.id }
									);
									eventService.consumeDraft(token, interaction.user.id);
									let content = `Événement publié (ID ${result?.eventId || 'inconnu'}).`;
									if (result?.scheduled) {
										const formatted = scheduledAt ? formatParisDate(scheduledAt) : null;
										content = formatted
										? `Événement programmé pour le ${formatted} (ID ${result?.eventId}).`
										: `Événement programmé (ID ${result?.eventId}).`;
									}
									await safeReply(interaction, { content, flags: MessageFlags.Ephemeral });
								} catch (err) {
									client?.context?.logger?.error?.({ err }, 'Failed to dispatch event announcement');
									await safeReply(interaction, { content: 'Erreur lors de la publication.', flags: MessageFlags.Ephemeral });
								}
								return;
							}
						}
						if (id.startsWith('event:ask:')) {
							const eventId = Number(id.split(':')[2]);
							if (!Number.isFinite(eventId)) {
								await safeReply(interaction, { content: 'Événement inconnu.', flags: MessageFlags.Ephemeral });
								return;
							}
							const modal = new ModalBuilder().setCustomId(`event:ask:modal:${eventId}`).setTitle('Question pour l’organisateur');
							const questionInput = new TextInputBuilder()
							.setCustomId('event_question')
							.setLabel('Ta question')
							.setStyle(TextInputStyle.Paragraph)
							.setRequired(true)
							.setMaxLength(500);
							modal.addComponents(new ActionRowBuilder().addComponents(questionInput));
							await interaction.showModal(modal);
							return;
						}
						if (id.startsWith('event:questionReply:')) {
							const questionId = Number(id.split(':')[2]);
							if (!Number.isFinite(questionId)) {
								await safeReply(interaction, { content: 'Question inconnue.', flags: MessageFlags.Ephemeral });
								return;
							}
							const question = await services.event.getQuestion(questionId);
							if (!question) {
								await safeReply(interaction, { content: 'Question introuvable.', flags: MessageFlags.Ephemeral });
								return;
							}
							const eventRow = await services.event.getEvent(question.event_id);
							const isAuthor = question.to_user_id && String(question.to_user_id) === interaction.user.id;
							const isEventOwner = eventRow?.author_id && String(eventRow.author_id) === interaction.user.id;
							const hasPerms = interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
							if (!isAuthor && !isEventOwner && !hasPerms) {
								await safeReply(interaction, { content: 'Tu ne peux pas répondre à cette question.', flags: MessageFlags.Ephemeral });
								return;
							}
							const modal = new ModalBuilder()
							.setCustomId(`event:questionReply:modal:${questionId}`)
							.setTitle('Répondre à la question');
							const answerInput = new TextInputBuilder()
							.setCustomId('event_answer')
							.setLabel('Réponse')
							.setStyle(TextInputStyle.Paragraph)
							.setRequired(true)
							.setMaxLength(1000);
							modal.addComponents(new ActionRowBuilder().addComponents(answerInput));
							await interaction.showModal(modal);
							return;
						}
						if (id === 'temp:fromAnon:create:closed') {
							if (!services.anon) {
								await safeReply(interaction, {
									content: 'Service indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							await services.anon.handleFromAnonCreateClosed(interaction);
							return;
						}
						if (id === 'temp:fromAnon:create:open') {
							if (!services.anon) {
								await safeReply(interaction, {
									content: 'Service indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							await services.anon.handleFromAnonCreateOpen(interaction);
							return;
						}
						if (id.startsWith('temp:open:join:')) {
							if (!services.anon) {
								await safeReply(interaction, {
									content: 'Service indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const groupId = Number(id.split(':')[3]);
							if (!Number.isFinite(groupId)) {
								await safeReply(interaction, {
									content: 'Identifiant de groupe invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							await services.anon.handleOpenJoin(interaction, groupId);
							return;
						}
						if (id.startsWith('temp:open:spectate:')) {
							if (!services.anon) {
								await safeReply(interaction, {
									content: 'Service indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const groupId = Number(id.split(':')[3]);
							if (!Number.isFinite(groupId)) {
								await safeReply(interaction, {
									content: 'Identifiant de groupe invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							await services.anon.handleOpenSpectate(interaction, groupId);
							return;
						}
						const tempGroupService = services.tempGroup;
						if (id.startsWith('temp:panel:')) {
							if (!tempGroupService) {
								await safeReply(interaction, {
									content: 'Service des groupes indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const match = id.match(/^temp:panel:(\d+):(refresh|invite)$/);
							if (!match) {
								await safeReply(interaction, {
									content: 'Action du panneau inconnue.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const tempGroupId = Number(match[1]);
							if (!Number.isFinite(tempGroupId)) {
								await safeReply(interaction, {
									content: 'Identifiant de groupe invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							if (match[2] === 'refresh') {
								const ok = await tempGroupService.updatePanel(tempGroupId);
								await safeReply(interaction, {
									content: ok ? 'Panneau rafraîchi.' : 'Groupe introuvable.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							if (match[2] === 'invite') {
								const group = await tempGroupService.getGroup(tempGroupId);
								if (!group) {
									await safeReply(interaction, {
										content: 'Groupe introuvable.',
										flags: MessageFlags.Ephemeral
									});
									return;
								}
								if (group.archived) {
									await safeReply(interaction, {
										content: 'Ce groupe est archivé.',
										flags: MessageFlags.Ephemeral
									});
									return;
								}
								const role = await tempGroupService.getMemberRole(tempGroupId, interaction.user.id);
								if (role !== 'member') {
									await safeReply(interaction, {
										content: 'Seuls les membres peuvent inviter.',
										flags: MessageFlags.Ephemeral
									});
									return;
								}
								const modal = new ModalBuilder()
								.setCustomId(`temp:panel:${tempGroupId}:inviteModal`)
								.setTitle('Inviter des membres');
								const input = new TextInputBuilder()
								.setCustomId('user_ids')
								.setLabel('IDs séparés par des espaces')
								.setStyle(TextInputStyle.Paragraph)
								.setRequired(true)
								.setPlaceholder('1234567890 0987654321');
								modal.addComponents(new ActionRowBuilder().addComponents(input));
								await interaction.showModal(modal);
								return;
							}
						}
						if (id.startsWith('temp:join:')) {
							if (!tempGroupService?.joinGroup) {
								await safeReply(interaction, {
									content: 'Service des groupes indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const tempGroupId = Number(id.split(':')[2]);
							if (!Number.isFinite(tempGroupId)) {
								await safeReply(interaction, {
									content: 'Identifiant de groupe invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const result = await tempGroupService.joinGroup(tempGroupId, interaction.user.id);
							await safeReply(interaction, {
								content: result?.message || (result?.ok ? 'Inscription enregistrée.' : 'Action impossible.'),
								flags: MessageFlags.Ephemeral
							});
							return;
						}
						if (id.startsWith('temp:spectate:')) {
							if (!tempGroupService?.spectateGroup) {
								await safeReply(interaction, {
									content: 'Service des groupes indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const tempGroupId = Number(id.split(':')[2]);
							if (!Number.isFinite(tempGroupId)) {
								await safeReply(interaction, {
									content: 'Identifiant de groupe invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const result = await tempGroupService.spectateGroup(tempGroupId, interaction.user.id);
							await safeReply(interaction, {
								content: result?.message || (result?.ok ? 'Mode spectateur activé.' : 'Action impossible.'),
								flags: MessageFlags.Ephemeral
							});
							return;
						}
						if (id.startsWith('temp:leave:')) {
							if (!tempGroupService?.leaveGroup) {
								await safeReply(interaction, {
									content: 'Service des groupes indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const tempGroupId = Number(id.split(':')[2]);
							if (!Number.isFinite(tempGroupId)) {
								await safeReply(interaction, {
									content: 'Identifiant de groupe invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const result = await tempGroupService.leaveGroup(tempGroupId, interaction.user.id);
							await safeReply(interaction, {
								content: result?.message || (result?.ok ? 'Groupe quitté.' : 'Action impossible.'),
								flags: MessageFlags.Ephemeral
							});
							return;
						}
						if (id.startsWith('temp:vote:')) {
							if (!tempGroupService?.handleVote) {
								await safeReply(interaction, {
									content: 'Service des groupes indisponible.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const match = id.match(/^temp:vote:(remove|keep):(\d+)$/);
							if (!match) {
								await safeReply(interaction, {
									content: 'Vote invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const action = match[1];
							const tempGroupId = Number(match[2]);
							if (!Number.isFinite(tempGroupId)) {
								await safeReply(interaction, {
									content: 'Identifiant de groupe invalide.',
									flags: MessageFlags.Ephemeral
								});
								return;
							}
							const result = await tempGroupService.handleVote(tempGroupId, interaction.user.id, action);
							let content = result?.message || 'Vote enregistré.';
							if (result?.ok) {
								if (result.status === 'archived') {
									content = 'Vote enregistré. Le groupe a été archivé.';
								} else if (result.status === 'unfrozen') {
									content = 'Vote enregistré. Le gel est levé.';
								} else if (result.status === 'vote-recorded') {
									const votes = Number(result.votes || 0);
									content = `Vote enregistré. ${votes}/3 pour la suppression.`;
								}
							}
							await safeReply(interaction, {
								content,
								flags: MessageFlags.Ephemeral
							});
							return;
						}
						if (id.startsWith('welcome:')) {
							await services.welcome.handleButton(interaction);
							return;
						}
						if (id.startsWith('panel:policy:profile:')) {
							await services.policy.handleProfileButton(interaction);
							return;
						}
						if (id.startsWith('panel:policy:code:gen:')) {
							await services.policy.handleGenerateCode(interaction);
							return;
						}
						if (id.startsWith('zone:approve:') || id.startsWith('zone:reject:')) {
							await services.policy.handleApprovalButton(interaction);
							return;
						}
						if (id.startsWith('req:')) {
							await services.policy.handleCreationRequestButton(interaction);
							return;
						}
						if (id.startsWith('event:join:')) {
							const eventId = Number(id.split(':')[2]);
							if (!Number.isFinite(eventId)) {
								await safeReply(interaction, { content: 'Événement inconnu.', flags: MessageFlags.Ephemeral });
								return;
							}
							const result = await services.event.joinEvent(eventId, interaction.user.id, interaction.channelId);
							await safeReply(interaction, {
								content:
								result?.message ||
								(result?.ok ? 'Inscription enregistrée.' : 'Impossible de traiter ta participation.'),
								flags: MessageFlags.Ephemeral
							});
							return;
						}
						if (id.startsWith('event:spectate:')) {
							const eventId = Number(id.split(':')[2]);
							if (!Number.isFinite(eventId)) {
								await safeReply(interaction, { content: 'Événement inconnu.', flags: MessageFlags.Ephemeral });
								return;
							}
							const result = await services.event.spectateEvent(eventId, interaction.user.id, interaction.channelId);
							await safeReply(interaction, {
								content:
								result?.message ||
								(result?.ok ? 'Mode spectateur enregistré.' : 'Impossible de te mettre en spectateur.'),
								flags: MessageFlags.Ephemeral
							});
							return;
						}
						if (id.startsWith('panel:')) {
							await services.panel.handleButton(interaction);
							return;
						}
					}

		if (interaction.type === InteractionType.ModalSubmit) {
			const id = customId;
			if (id === 'announce:modal' || id.startsWith('announce:modal:')) {
				const token = id.split(':')[2] || null;
				const title = (interaction.fields.getTextInputValue('announce_title') || '').trim();
				const content = (interaction.fields.getTextInputValue('announce_content') || '').trim();
				if (!title || !content) {
					await interaction.reply({
						content: 'Merci de renseigner un titre et un contenu.',
						flags: MessageFlags.Ephemeral
					});
					return;
				}
				const eventService = services.event;
				if (!eventService) {
					await interaction.reply({ content: 'Service indisponible.', flags: MessageFlags.Ephemeral });
					return;
				}
				const existing = token ? eventService.getDraft(token, interaction.user.id) : null;
				const scheduledAt = existing?.payload?.scheduledAt || null;
				const payload = {
					type: 'announcement',
					title,
					content,
					authorId: interaction.user.id,
					scheduledAt
				};
				let draftToken = token;
				let draft = null;
				if (existing) {
					draft = eventService.updateDraft(token, interaction.user.id, payload);
				} else {
					draftToken = eventService.createDraft('announce', interaction.user.id, payload, token || undefined);
					draft = eventService.getDraft(draftToken, interaction.user.id);
				}
				await replyWithPreview(interaction, services, 'announce', draft, draftToken);
				return;
			}
			if (id.startsWith('announce:schedule:')) {
				const token = id.split(':')[2];
				const eventService = services.event;
				if (!token || !eventService) {
					await interaction.reply({ content: 'Brouillon introuvable.', flags: MessageFlags.Ephemeral });
					return;
				}
				const draft = eventService.getDraft(token, interaction.user.id);
				if (!draft) {
					await interaction.reply({ content: 'Brouillon introuvable.', flags: MessageFlags.Ephemeral });
					return;
				}
				const dateRaw = (interaction.fields.getTextInputValue('schedule_date') || '').trim();
				const timeRaw = (interaction.fields.getTextInputValue('schedule_time') || '').trim();
				const scheduledAt = eventService.resolveSchedule(dateRaw, timeRaw);
				if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
					await interaction.reply({ content: 'Date/heure invalides.', flags: MessageFlags.Ephemeral });
					return;
				}
				const payload = { ...draft.payload, scheduledAt: scheduledAt.toISOString() };
				const updated = eventService.updateDraft(token, interaction.user.id, payload);
				await replyWithPreview(interaction, services, 'announce', updated, token);
				return;
			}
			if (id === 'event:modal' || id.startsWith('event:modal:')) {
				const token = id.split(':')[2] || null;
				const title = (interaction.fields.getTextInputValue('event_title') || '').trim();
				const game = (interaction.fields.getTextInputValue('event_game') || '').trim();
				const description = (interaction.fields.getTextInputValue('event_content') || '').trim();
				const dateRaw = (interaction.fields.getTextInputValue('event_date') || '').trim();
				const timeRaw = (interaction.fields.getTextInputValue('event_time') || '').trim();
				const duration = (interaction.fields.getTextInputValue('event_duration') || '').trim();
				const maxRaw = (interaction.fields.getTextInputValue('event_max') || '').trim();
				const groupRaw = (interaction.fields.getTextInputValue('event_group') || '').trim().toLowerCase();
				if (!title || !description) {
					await interaction.reply({ content: 'Titre et description requis.', flags: MessageFlags.Ephemeral });
					return;
				}
				const eventService = services.event;
				if (!eventService) {
					await interaction.reply({ content: 'Service indisponible.', flags: MessageFlags.Ephemeral });
					return;
				}
				const existing = token ? eventService.getDraft(token, interaction.user.id) : null;
				const scheduledAt = existing?.payload?.scheduledAt || null;
				const tempGroupId = existing?.payload?.tempGroupId || null;
				const maxParticipants = Number.parseInt(maxRaw, 10);
				const payload = {
					type: 'event',
					title,
					description,
					game: game || null,
					expectedDate: dateRaw || null,
					expectedTime: timeRaw || null,
					expectedDuration: duration || null,
					maxParticipants: Number.isFinite(maxParticipants) && maxParticipants > 0 ? maxParticipants : null,
					createTempGroup: ['oui', 'yes', 'y', '1', 'true'].includes(groupRaw),
					authorId: interaction.user.id,
					scheduledAt,
					tempGroupId
				};
				let draftToken = token;
				let draft = null;
				if (existing) {
					draft = eventService.updateDraft(token, interaction.user.id, payload);
				} else {
					draftToken = eventService.createDraft('event', interaction.user.id, payload, token || undefined);
					draft = eventService.getDraft(draftToken, interaction.user.id);
				}
				await replyWithPreview(interaction, services, 'event', draft, draftToken);
				return;
			}
			if (id.startsWith('event:schedule:')) {
				const token = id.split(':')[2];
				const eventService = services.event;
				if (!token || !eventService) {
					await interaction.reply({ content: 'Brouillon introuvable.', flags: MessageFlags.Ephemeral });
					return;
				}
				const draft = eventService.getDraft(token, interaction.user.id);
				if (!draft) {
					await interaction.reply({ content: 'Brouillon introuvable.', flags: MessageFlags.Ephemeral });
					return;
				}
				const dateRaw = (interaction.fields.getTextInputValue('schedule_date') || '').trim();
				const timeRaw = (interaction.fields.getTextInputValue('schedule_time') || '').trim();
				const scheduledAt = eventService.resolveSchedule(dateRaw, timeRaw);
				if (!scheduledAt || Number.isNaN(scheduledAt.getTime())) {
					await interaction.reply({ content: 'Date/heure invalides.', flags: MessageFlags.Ephemeral });
					return;
				}
				const payload = { ...draft.payload, scheduledAt: scheduledAt.toISOString() };
				const updated = eventService.updateDraft(token, interaction.user.id, payload);
				await replyWithPreview(interaction, services, 'event', updated, token);
				return;
			}
			if (id.startsWith('event:ask:modal:')) {
				const eventId = Number(id.split(':')[3]);
				if (!Number.isFinite(eventId)) {
					await interaction.reply({ content: 'Événement inconnu.', flags: MessageFlags.Ephemeral });
					return;
				}
				const question = (interaction.fields.getTextInputValue('event_question') || '').trim();
				if (!question) {
					await interaction.reply({ content: 'Question vide.', flags: MessageFlags.Ephemeral });
					return;
				}
				const record = await services.event.recordQuestion(eventId, interaction.user.id, question);
				if (!record) {
					await interaction.reply({ content: 'Impossible d’enregistrer la question.', flags: MessageFlags.Ephemeral });
					return;
				}
				await services.event.deliverQuestionToAuthor(record);
				await interaction.reply({ content: 'Question envoyée à l’organisateur.', flags: MessageFlags.Ephemeral });
				return;
			}
			if (id.startsWith('event:questionReply:modal:')) {
				const questionId = Number(id.split(':')[3]);
				if (!Number.isFinite(questionId)) {
					await interaction.reply({ content: 'Question inconnue.', flags: MessageFlags.Ephemeral });
					return;
				}
				const answer = (interaction.fields.getTextInputValue('event_answer') || '').trim();
				if (!answer) {
					await interaction.reply({ content: 'Réponse vide.', flags: MessageFlags.Ephemeral });
					return;
				}
				const question = await services.event.getQuestion(questionId);
				if (!question) {
					await interaction.reply({ content: 'Question introuvable.', flags: MessageFlags.Ephemeral });
					return;
				}
				const eventRow = await services.event.getEvent(question.event_id);
				const isAuthor = question.to_user_id && String(question.to_user_id) === interaction.user.id;
				const isEventOwner = eventRow?.author_id && String(eventRow.author_id) === interaction.user.id;
				const hasPerms = interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild);
				if (!isAuthor && !isEventOwner && !hasPerms) {
					await interaction.reply({ content: 'Tu ne peux pas répondre à cette question.', flags: MessageFlags.Ephemeral });
					return;
				}
				await services.event.recordAnswer(questionId, answer);
				await services.event.deliverAnswerToAsker(question, answer);
				if (interaction.message) {
					await interaction.message.edit({ components: [] }).catch(() => {});
				}
				await interaction.reply({ content: 'Réponse envoyée.', flags: MessageFlags.Ephemeral });
				return;
			}
if (id.startsWith('temp:panel:')) {
                                        const tempGroupService = services.tempGroup;
                                        if (!tempGroupService?.inviteMembers) {
                                                await safeReply(interaction, {
                                                        content: 'Service des groupes indisponible.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const match = id.match(/^temp:panel:(\d+):inviteModal$/);
                                        if (!match) {
                                                await safeReply(interaction, {
                                                        content: 'Action du panneau inconnue.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const tempGroupId = Number(match[1]);
                                        if (!Number.isFinite(tempGroupId)) {
                                                await safeReply(interaction, {
                                                        content: 'Identifiant de groupe invalide.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        const raw = interaction.fields.getTextInputValue('user_ids') || '';
                                        const ids = raw
                                                .split(/\s+/)
                                                .map((part) => part.replace(/[^0-9]/g, ''))
                                                .filter(Boolean);
                                        const result = await tempGroupService.inviteMembers(tempGroupId, interaction.user.id, ids);
                                        await safeReply(interaction, {
                                                content:
                                                        result?.message ||
                                                        (result?.ok
                                                                ? 'Invitations traitées.'
                                                                : 'Impossible de traiter les invitations.'),
                                                flags: MessageFlags.Ephemeral
                                        });
                                        return;
                                }
                                if (id.startsWith('req:editaccept:')) {
                                        await services.policy.handleCreationRequestModal(interaction);
                                        return;
                                }
                                if (id.startsWith('zone:request:') || id === 'welcome:request:modal') {
                                        await services.policy.handleZoneRequestModal(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:policy:profile:modal:')) {
                                        await services.policy.handleProfileModal(interaction);
                                        return;
                                }
                                if (id.startsWith('welcome:')) {
                                        await services.welcome.handleModal(interaction);
                                        return;
                                }
                                if (id.startsWith('panel:')) {
                                        await services.panel.handleModal(interaction);
                                        return;
                                }
                        }
                } catch (err) {
                        if (isUnknownInteractionError(err)) {
                                client?.context?.logger?.warn({ err }, 'Unknown interaction encountered');
                                return;
                        }
                        client?.context?.logger?.error({ err }, 'interactionCreate handler error');
                        await safeReply(interaction, {
                                content: 'Erreur lors du traitement.',
                                flags: MessageFlags.Ephemeral
                        });
                } finally {
                        if (throttleKey && throttleService) {
                                await throttleService.end(interaction.user.id, throttleKey);
                        }
                }
        }
};
