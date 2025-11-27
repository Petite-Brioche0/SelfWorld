const {
InteractionType,
MessageFlags,
DiscordAPIError,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle,
EmbedBuilder,
ModalBuilder,
TextInputBuilder,
TextInputStyle
} = require('discord.js');
const { parseId, makeId } = require('../utils/ids');

const DEFAULT_THROTTLE_SECONDS = 4;

function matchId(parsed, namespace, ...segments) {
        if (!parsed || parsed.namespace !== namespace) return false;
        const parts = parsed.parts || parsed.segments || [];
        for (let i = 0; i < segments.length; i += 1) {
                if (parts[i] !== segments[i]) {
                        return false;
                }
        }
        return true;
}

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
                const parsed = parseId(id);
                if (matchId(parsed, 'zone', 'request') || matchId(parsed, 'welcome', 'request', 'modal')) {
                        return { key: 'zone.request.create', seconds: 600 };
                }
                if (matchId(parsed, 'req', 'editaccept')) {
                        return { key: 'zone.request.review', seconds: 8 };
                }
                if (matchId(parsed, 'panel', 'role', 'create')) {
                        return { key: 'zone.role.create', seconds: 60 };
                }
                if (matchId(parsed, 'panel', 'ch', 'create')) {
                        return { key: 'panel.channels.edit', seconds: 25 };
                }
                if (parsed?.namespace === 'panel') {
                        return { key: 'panel.modal', seconds: 10 };
                }
                return { key: 'modal.generic', seconds: DEFAULT_THROTTLE_SECONDS };
        }

        if (interaction.isButton()) {
                const id = interaction.customId || '';
                const parsed = parseId(id);
                if (matchId(parsed, 'panel', 'refresh')) {
                        return { key: 'panel.refresh', seconds: 10 };
                }
                if (matchId(parsed, 'panel', 'role')) {
                        return { key: 'panel.roles.edit', seconds: 25 };
                }
                if (matchId(parsed, 'panel', 'ch')) {
                        return { key: 'panel.channels.edit', seconds: 25 };
                }
                if (matchId(parsed, 'panel', 'member')) {
                        return { key: 'panel.members.manage', seconds: 15 };
                }
                if (matchId(parsed, 'panel', 'policy')) {
                        return { key: 'panel.policy', seconds: 12 };
                }
                if (parsed?.namespace === 'req') {
                        return { key: 'zone.request.review', seconds: 8 };
                }
                if (matchId(parsed, 'zone', 'approve') || matchId(parsed, 'zone', 'reject')) {
                        return { key: 'zone.request.review', seconds: 8 };
                }
                if (parsed?.namespace === 'welcome') {
                        return { key: 'welcome.flow', seconds: 5 };
                }
                return { key: 'button.generic', seconds: DEFAULT_THROTTLE_SECONDS };
        }

        if (interaction.isStringSelectMenu()) {
                const id = interaction.customId || '';
                const parsed = parseId(id);
                if (matchId(parsed, 'panel', 'policy')) {
                        return { key: 'panel.policy', seconds: 10 };
                }
                if (parsed?.namespace === 'panel') {
                        return { key: 'panel.select', seconds: 6 };
                }
                if (matchId(parsed, 'admin', 'zonecreate')) {
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

		const buildPreviewButtons = (namespace, eventId) =>
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(makeId(`${namespace}:preview:cancel`, eventId))
					.setStyle(ButtonStyle.Secondary)
					.setLabel('Annuler'),
				new ButtonBuilder()
					.setCustomId(makeId(`${namespace}:preview:edit`, eventId))
					.setStyle(ButtonStyle.Secondary)
					.setLabel('Modifier'),
				new ButtonBuilder()
					.setCustomId(makeId(`${namespace}:preview:confirm`, eventId))
					.setStyle(ButtonStyle.Success)
					.setLabel('Diffuser'),
				new ButtonBuilder()
					.setCustomId(makeId(`${namespace}:preview:schedule`, eventId))
					.setStyle(ButtonStyle.Primary)
					.setLabel('Programmer')
			);

		const parseParisSchedule = (dateStr, timeStr) => {
			const [day, month, year] = (dateStr || '').split('/').map((n) => Number(n));
			const [hour, minute] = (timeStr || '').split(':').map((n) => Number(n));
			if (!year || !month || !day || Number.isNaN(hour) || Number.isNaN(minute)) {
				return null;
			}
			const utcGuess = Date.UTC(year, month - 1, day, hour, minute);
			const formatter = new Intl.DateTimeFormat('en-US', {
				timeZone: 'Europe/Paris',
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
				hour: '2-digit',
				minute: '2-digit',
				second: '2-digit',
				hour12: false
			});
			const parts = formatter.formatToParts(new Date(utcGuess)).reduce((acc, part) => {
				if (part.type !== 'literal') acc[part.type] = Number(part.value);
				return acc;
			}, {});
			const zoned = Date.UTC(
				parts.year,
				(parts.month || 1) - 1,
				parts.day || 1,
				parts.hour || 0,
				parts.minute || 0,
				parts.second || 0
			);
			const offset = zoned - utcGuess;
			return new Date(utcGuess - offset);
		};

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
                        const parsedCustomId = parseId(customId);
                        const isReception = services.zone?.isReceptionChannel?.(interaction.channelId) === true;
                        if (parsedCustomId?.namespace === 'welcome' && isReception) {
                                interaction.forceWelcomeEphemeral = true;
                        }

                        if (interaction.isStringSelectMenu()) {
                                if (matchId(parsedCustomId, 'admin', 'zonecreate')) {
                                        const cmd = commands.get('zone-create');
                                        if (cmd?.handlePolicySelect) {
                                                await cmd.handlePolicySelect(interaction, client.context);
                                                return;
                                        }
                                }
                                if (matchId(parsedCustomId, 'panel', 'policy', 'set')) {
                                        await services.policy.handlePolicySelect(interaction);
                                        return;
                                }
                                if (matchId(parsedCustomId, 'panel', 'policy', 'askmode')) {
                                        await services.policy.handleAskModeSelect(interaction);
                                        return;
                                }
                                if (matchId(parsedCustomId, 'panel', 'policy', 'approver')) {
                                        await services.policy.handleApproverSelect(interaction);
                                        return;
                                }
                                if (parsedCustomId?.namespace === 'panel') {
                                        await services.panel.handleSelectMenu(interaction);
                                        return;
                                }
                        }

                        if (interaction.isButton()) {
                                if (parsedCustomId?.namespace === 'welcome') {
                                        await services.welcome.handleButton(interaction);
                                        return;
                                }
                                if (matchId(parsedCustomId, 'temp', 'panel')) {
                                        const tempGroupId = Number(parsedCustomId.parts?.[1]);
                                        if (!tempGroupId) {
                                                await safeReply(interaction, {
                                                        content: 'Groupe temporaire introuvable.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        if (matchId(parsedCustomId, 'temp', 'panel', String(tempGroupId), 'refresh')) {
                                                try {
                                                        await services.tempGroup.updatePanel(tempGroupId);
                                                        await safeReply(interaction, {
                                                                content: 'Panel rafraîchi.',
                                                                flags: MessageFlags.Ephemeral
                                                        });
                                                } catch (err) {
                                                        await safeReply(interaction, {
                                                                content: `Impossible de rafraîchir le panel : ${err?.message || err}`,
                                                                flags: MessageFlags.Ephemeral
                                                        });
                                                }
                                                return;
                                        }
                                        if (matchId(parsedCustomId, 'temp', 'panel', String(tempGroupId), 'invite')) {
                                                if (typeof services.tempGroup?.openInviteModal === 'function') {
                                                        try {
                                                                await services.tempGroup.openInviteModal(tempGroupId, interaction);
                                                        } catch (err) {
                                                                await safeReply(interaction, {
                                                                        content: `Impossible d’ouvrir l’invitation : ${err?.message || err}`,
                                                                        flags: MessageFlags.Ephemeral
                                                                });
                                                        }
                                                } else {
                                                        await safeReply(interaction, {
                                                                content: 'Invitation non implémentée.',
                                                                flags: MessageFlags.Ephemeral
                                                        });
                                                }
                                                return;
                                        }
                                }
                                if (matchId(parsedCustomId, 'temp', 'join')) {
                                        const tempGroupId = Number(parsedCustomId.parts?.[1]);
                                        if (!tempGroupId) {
                                                await safeReply(interaction, {
                                                        content: 'Groupe temporaire introuvable.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        try {
                                                await services.tempGroup.addMembers(tempGroupId, [interaction.user.id]);
                                                await safeReply(interaction, {
                                                        content: 'Tu as rejoint le groupe.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        } catch (err) {
                                                await safeReply(interaction, {
                                                        content: `Impossible de rejoindre le groupe : ${err?.message || err}`,
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        }
                                        return;
                                }
                                if (matchId(parsedCustomId, 'temp', 'spectate')) {
                                        const tempGroupId = Number(parsedCustomId.parts?.[1]);
                                        if (!tempGroupId) {
                                                await safeReply(interaction, {
                                                        content: 'Groupe temporaire introuvable.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        try {
                                                await services.tempGroup.addSpectators(tempGroupId, [interaction.user.id]);
                                                await safeReply(interaction, {
                                                        content: 'Tu observes ce groupe.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        } catch (err) {
                                                await safeReply(interaction, {
                                                        content: `Impossible de rejoindre en spectateur : ${err?.message || err}`,
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        }
                                        return;
                                }
                                if (matchId(parsedCustomId, 'temp', 'leave')) {
                                        const tempGroupId = Number(parsedCustomId.parts?.[1]);
                                        if (!tempGroupId) {
                                                await safeReply(interaction, {
                                                        content: 'Groupe temporaire introuvable.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        try {
                                                await services.tempGroup.removeUser(tempGroupId, interaction.user.id);
                                                await safeReply(interaction, {
                                                        content: 'Tu as quitté le groupe.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        } catch (err) {
                                                await safeReply(interaction, {
                                                        content: `Impossible de quitter le groupe : ${err?.message || err}`,
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        }
                                        return;
                                }
                                if (matchId(parsedCustomId, 'temp', 'vote')) {
                                        await services.tempGroup.handleVoteButton(interaction);
                                        return;
                                }
                                if (matchId(parsedCustomId, 'panel', 'policy', 'profile')) {
					await services.policy.handleProfileButton(interaction);
					return;
				}
				if (matchId(parsedCustomId, 'panel', 'policy', 'code', 'gen')) {
					await services.policy.handleGenerateCode(interaction);
					return;
				}
				if (matchId(parsedCustomId, 'zone', 'approve') || matchId(parsedCustomId, 'zone', 'reject')) {
					await services.policy.handleApprovalButton(interaction);
					return;
				}
				if (parsedCustomId?.namespace === 'req') {
					await services.policy.handleCreationRequestButton(interaction);
					return;
				}
if (matchId(parsedCustomId, 'temp', 'extend') || matchId(parsedCustomId, 'temp', 'delete')) {
await services.tempGroup.handleArchiveButtons(interaction);
return;
}
if (matchId(parsedCustomId, 'event', 'join')) {
await services.event.handleJoinButton(interaction);
return;
}
if (matchId(parsedCustomId, 'ann', 'openModal')) {
const modal = new ModalBuilder()
.setCustomId(makeId('ann:modal'))
.setTitle('Nouvelle annonce')
.addComponents(
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('title')
.setLabel('Titre')
.setStyle(TextInputStyle.Short)
.setRequired(true)
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('content')
.setLabel('Contenu')
.setStyle(TextInputStyle.Paragraph)
.setRequired(true)
)
);
await interaction.showModal(modal);
return;
}
if (matchId(parsedCustomId, 'ann', 'preview', 'confirm')) {
const eventId = Number(parsedCustomId.parts?.[2]);
if (!eventId) return;
await services.event.dispatchAnnouncement(eventId);
await safeReply(interaction, { content: 'Annonce envoyée.', flags: MessageFlags.Ephemeral });
return;
}
if (matchId(parsedCustomId, 'ann', 'preview', 'schedule')) {
const eventId = Number(parsedCustomId.parts?.[2]);
if (!eventId) return;
const modal = new ModalBuilder()
.setCustomId(makeId('ann:schedule', eventId))
.setTitle('Programmer une annonce')
.addComponents(
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('date')
.setLabel('Date (JJ/MM/AAAA)')
.setStyle(TextInputStyle.Short)
.setRequired(true)
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('time')
.setLabel('Heure (HH:MM)')
.setStyle(TextInputStyle.Short)
.setRequired(true)
)
);
await interaction.showModal(modal);
return;
}
if (matchId(parsedCustomId, 'ann', 'preview', 'edit')) {
const eventId = Number(parsedCustomId.parts?.[2]);
const existing = await services.event.getEventById(eventId);
if (!existing) {
await safeReply(interaction, { content: 'Brouillon introuvable.', flags: MessageFlags.Ephemeral });
return;
}
const payload = existing.announce_payload
? JSON.parse(existing.announce_payload)
: { title: existing.name, content: existing.description };
const modal = new ModalBuilder()
.setCustomId(makeId('ann:modal', eventId))
.setTitle('Modifier l’annonce')
.addComponents(
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('title')
.setLabel('Titre')
.setStyle(TextInputStyle.Short)
.setRequired(true)
.setValue(payload.title || '')
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('content')
.setLabel('Contenu')
.setStyle(TextInputStyle.Paragraph)
.setRequired(true)
.setValue(payload.content || '')
)
);
await interaction.showModal(modal);
return;
}
if (matchId(parsedCustomId, 'ann', 'preview', 'cancel')) {
await safeReply(interaction, { content: 'Brouillon annulé.', flags: MessageFlags.Ephemeral });
return;
}
if (matchId(parsedCustomId, 'evt', 'openModal')) {
const modal = new ModalBuilder()
.setCustomId(makeId('evt:modal'))
.setTitle('Nouvel événement')
.addComponents(
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('title')
.setLabel('Titre')
.setStyle(TextInputStyle.Short)
.setRequired(true)
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('game')
.setLabel('Jeu (optionnel)')
.setStyle(TextInputStyle.Short)
.setRequired(false)
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('description')
.setLabel('Description (optionnel)')
.setStyle(TextInputStyle.Paragraph)
.setRequired(false)
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('datetime')
.setLabel('Date/heure (JJ/MM/AAAA HH:MM)')
.setStyle(TextInputStyle.Short)
.setRequired(false)
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('max_temp')
.setLabel('Max participants ; temp group (oui/non)')
.setStyle(TextInputStyle.Short)
.setRequired(false)
)
);
await interaction.showModal(modal);
return;
}
if (matchId(parsedCustomId, 'evt', 'preview', 'confirm')) {
const eventId = Number(parsedCustomId.parts?.[2]);
if (!eventId) return;
await services.event.dispatchEvent(eventId);
await safeReply(interaction, { content: 'Événement publié.', flags: MessageFlags.Ephemeral });
return;
}
if (matchId(parsedCustomId, 'evt', 'preview', 'schedule')) {
const eventId = Number(parsedCustomId.parts?.[2]);
if (!eventId) return;
const modal = new ModalBuilder()
.setCustomId(makeId('evt:schedule', eventId))
.setTitle('Programmer un événement')
.addComponents(
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('date')
.setLabel('Date (JJ/MM/AAAA)')
.setStyle(TextInputStyle.Short)
.setRequired(true)
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('time')
.setLabel('Heure (HH:MM)')
.setStyle(TextInputStyle.Short)
.setRequired(true)
)
);
await interaction.showModal(modal);
return;
}
if (matchId(parsedCustomId, 'evt', 'preview', 'edit')) {
const eventId = Number(parsedCustomId.parts?.[2]);
const existing = await services.event.getEventById(eventId);
if (!existing) {
await safeReply(interaction, { content: 'Brouillon introuvable.', flags: MessageFlags.Ephemeral });
return;
}
const modal = new ModalBuilder()
.setCustomId(makeId('evt:modal', eventId))
.setTitle('Modifier l’événement')
.addComponents(
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('title')
.setLabel('Titre')
.setStyle(TextInputStyle.Short)
.setRequired(true)
.setValue(existing.name || '')
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('game')
.setLabel('Jeu (optionnel)')
.setStyle(TextInputStyle.Short)
.setRequired(false)
.setValue(existing.game || '')
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('description')
.setLabel('Description (optionnel)')
.setStyle(TextInputStyle.Paragraph)
.setRequired(false)
.setValue(existing.description || '')
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('datetime')
.setLabel('Date/heure (JJ/MM/AAAA HH:MM)')
.setStyle(TextInputStyle.Short)
.setRequired(false)
.setValue(
existing.starts_at
? new Date(existing.starts_at).toLocaleString('fr-FR', {
timeZone: 'Europe/Paris',
year: 'numeric',
month: '2-digit',
day: '2-digit',
hour: '2-digit',
minute: '2-digit'
})
: ''
)
),
new ActionRowBuilder().addComponents(
new TextInputBuilder()
.setCustomId('max_temp')
.setLabel('Max participants ; temp group (oui/non)')
.setStyle(TextInputStyle.Short)
.setRequired(false)
.setValue(
existing.max_participants
? `${existing.max_participants};${existing.temp_group_id ? 'oui' : 'non'}`
: `${existing.temp_group_id ? '0;oui' : ''}`
)
)
);
await interaction.showModal(modal);
return;
}
if (matchId(parsedCustomId, 'evt', 'preview', 'cancel')) {
await safeReply(interaction, { content: 'Brouillon annulé.', flags: MessageFlags.Ephemeral });
return;
}
if (matchId(parsedCustomId, 'anon', 'create', 'closed')) {
if (!services.tempGroup || !interaction.guild) {
await safeReply(interaction, {
                                                        content: 'Création indisponible pour le moment.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        try {
const created = await services.tempGroup.createTempGroup(interaction.guild, {
name: 'Groupe anonyme',
isOpen: false,
participants: [interaction.user.id],
authorId: interaction.user.id,
requester: interaction.user
});
                                                await safeReply(interaction, {
                                                        content: `Groupe créé : <#${created.textChannelId}>`,
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        } catch (err) {
                                                await safeReply(interaction, {
                                                        content: `Impossible de créer le groupe : ${err?.message || err}`,
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        }
                                        return;
                                }
                                if (matchId(parsedCustomId, 'anon', 'create', 'open')) {
                                        if (!services.tempGroup || !interaction.guild) {
                                                await safeReply(interaction, {
                                                        content: 'Création indisponible pour le moment.',
                                                        flags: MessageFlags.Ephemeral
                                                });
                                                return;
                                        }
                                        try {
const created = await services.tempGroup.createTempGroup(interaction.guild, {
name: 'Groupe anonyme ouvert',
isOpen: true,
participants: [interaction.user.id],
authorId: interaction.user.id,
requester: interaction.user
});
                                                const row = new ActionRowBuilder().addComponents(
                                                        new ButtonBuilder()
                                                                .setCustomId(makeId('temp:join', created.id))
                                                                .setLabel('Rejoindre')
                                                                .setStyle(ButtonStyle.Success),
                                                        new ButtonBuilder()
                                                                .setCustomId(makeId('temp:spectate', created.id))
                                                                .setLabel('Observer')
                                                                .setStyle(ButtonStyle.Secondary),
                                                        new ButtonBuilder()
                                                                .setCustomId(makeId('temp:leave', created.id))
                                                                .setLabel('Quitter')
                                                                .setStyle(ButtonStyle.Danger)
                                                );
                                                const embed = new EmbedBuilder()
                                                        .setTitle('Groupe temporaire anonyme')
                                                        .setDescription('Rejoignez ce groupe pour continuer en privé.')
                                                        .setColor(0x5865f2);
                                                if (interaction.channel) {
                                                        await interaction.channel
                                                                .send({ embeds: [embed], components: [row] })
                                                                .catch(() => {});
                                                }
                                                await safeReply(interaction, {
                                                        content: `Groupe créé : <#${created.textChannelId}>`,
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        } catch (err) {
                                                await safeReply(interaction, {
                                                        content: `Impossible de créer le groupe : ${err?.message || err}`,
                                                        flags: MessageFlags.Ephemeral
                                                });
                                        }
                                        return;
                                }
                                if (parsedCustomId?.namespace === 'panel') {
                                        await services.panel.handleButton(interaction);
                                        return;
                                }
                        }

			if (interaction.type === InteractionType.ModalSubmit) {
				if (matchId(parsedCustomId, 'req', 'editaccept')) {
					await services.policy.handleCreationRequestModal(interaction);
					return;
				}
				if (matchId(parsedCustomId, 'zone', 'request') || matchId(parsedCustomId, 'welcome', 'request', 'modal')) {
					await services.policy.handleZoneRequestModal(interaction);
					return;
				}
				if (parsedCustomId?.namespace === 'ann' && parsedCustomId.parts?.[0] === 'modal') {
					const title = interaction.fields.getTextInputValue('title');
					const content = interaction.fields.getTextInputValue('content');
					const eventId = Number(parsedCustomId.parts?.[1]) || null;
					const payload = { title, content };
					const savedId = await services.event.saveAnnouncementDraft(payload, {
						authorId: interaction.user.id,
						guildId: interaction.guildId,
						eventId
					});
					const embed = services.event.buildAnnouncementEmbed(payload);
					await safeReply(interaction, {
						content: 'Prévisualisation',
						embeds: [embed],
						components: [buildPreviewButtons('ann', savedId)],
						flags: MessageFlags.Ephemeral
					});
					return;
				}
				if (parsedCustomId?.namespace === 'ann' && parsedCustomId.parts?.[0] === 'schedule') {
					const eventId = Number(parsedCustomId.parts?.[1]);
					const date = interaction.fields.getTextInputValue('date');
					const time = interaction.fields.getTextInputValue('time');
					const scheduled = parseParisSchedule(date, time);
					if (!scheduled) {
						await safeReply(interaction, { content: 'Date invalide.', flags: MessageFlags.Ephemeral });
						return;
					}
					await services.event.markScheduled(eventId, scheduled);
					await safeReply(interaction, {
						content: `Annonce programmée pour ${scheduled.toISOString()}.`,
						flags: MessageFlags.Ephemeral
					});
					return;
				}
				if (parsedCustomId?.namespace === 'evt' && parsedCustomId.parts?.[0] === 'modal') {
					const title = interaction.fields.getTextInputValue('title');
					const game = interaction.fields.getTextInputValue('game');
					const description = interaction.fields.getTextInputValue('description');
					const datetime = interaction.fields.getTextInputValue('datetime');
					const maxTemp = interaction.fields.getTextInputValue('max_temp');
					const eventId = Number(parsedCustomId.parts?.[1]) || null;

					let startsAt = null;
					if (datetime) {
						const [d, t] = datetime.split(' ');
						const parsed = parseParisSchedule(d, t);
						if (parsed) startsAt = parsed.toISOString().slice(0, 19).replace('T', ' ');
					}
					let maxParticipants = null;
					let createTempGroup = false;
					if (maxTemp) {
						const [maxStr, tempFlag] = maxTemp.split(';');
						if (maxStr) {
							const n = Number(maxStr);
							if (!Number.isNaN(n) && n > 0) {
								maxParticipants = n;
							}
						}
						if ((tempFlag || '').trim().toLowerCase() === 'oui') {
							createTempGroup = true;
						}
					}
const form = { title, description, game, startsAt, maxParticipants };
const savedId = await services.event.saveEventDraft(form, {
authorId: interaction.user.id,
guildId: interaction.guildId,
createTempGroup,
eventId
});
const embed = services.event.buildEventEmbed({
name: title,
description,
game,
starts_at: startsAt,
max_participants: maxParticipants
});
					await safeReply(interaction, {
						content: 'Prévisualisation',
						embeds: [embed],
						components: [buildPreviewButtons('evt', savedId)],
						flags: MessageFlags.Ephemeral
					});
					return;
				}
				if (parsedCustomId?.namespace === 'evt' && parsedCustomId.parts?.[0] === 'schedule') {
					const eventId = Number(parsedCustomId.parts?.[1]);
					const date = interaction.fields.getTextInputValue('date');
					const time = interaction.fields.getTextInputValue('time');
					const scheduled = parseParisSchedule(date, time);
					if (!scheduled) {
						await safeReply(interaction, { content: 'Date invalide.', flags: MessageFlags.Ephemeral });
						return;
					}
					await services.event.markScheduled(eventId, scheduled);
					await safeReply(interaction, {
						content: `Événement programmé pour ${scheduled.toISOString()}.`,
						flags: MessageFlags.Ephemeral
					});
					return;
				}
if (matchId(parsedCustomId, 'panel', 'policy', 'profile', 'modal')) {
await services.policy.handleProfileModal(interaction);
return;
                                }
                                if (parsedCustomId?.namespace === 'welcome') {
                                        await services.welcome.handleModal(interaction);
                                        return;
                                }
                                if (parsedCustomId?.namespace === 'panel') {
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
