const {
	InteractionType,
	MessageFlags
} = require('discord.js');
const { parseId } = require('../utils/ids');

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

async function routeOrNotify(interaction, handler, label) {
	if (!handler) {
		await safeReply(interaction, {
			content: `Handler manquant (${label}).`,
			flags: MessageFlags.Ephemeral
		});
		return false;
	}
	await handler(interaction);
	return true;
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
			const parsedCustomId = parseId(customId);
			const isReception = services.zone?.isReceptionChannel?.(interaction.channelId) === true;
			if (parsedCustomId?.namespace === 'welcome' && isReception) {
				interaction.forceWelcomeEphemeral = true;
			}

			if (interaction.isStringSelectMenu()) {
				if (matchId(parsedCustomId, 'anon', 'closed', 'select')) {
					await routeOrNotify(
					interaction,
					services.anon?.handleClosedSelect?.bind(services.anon),
					'anon.handleClosedSelect'
					);
					return;
				}
				if (matchId(parsedCustomId, 'admin', 'zonecreate')) {
					const cmd = commands.get('zone-create');
					if (cmd?.handlePolicySelect) {
						await cmd.handlePolicySelect(interaction, client.context);
					}
					return;
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
				if (matchId(parsedCustomId, 'ann')) {
					const handled = await routeOrNotify(
					interaction,
					services.event?.handleAnnouncementInteraction?.bind(services.event),
					'event.handleAnnouncementInteraction'
					);
					if (handled) return;
				}
				if (matchId(parsedCustomId, 'evt')) {
					const handled = await routeOrNotify(
					interaction,
					services.event?.handleEventInteraction?.bind(services.event),
					'event.handleEventInteraction'
					);
					if (handled) return;
				}
				if (matchId(parsedCustomId, 'anon')) {
					const handled = await routeOrNotify(
					interaction,
					services.anon?.handleAnonInteraction?.bind(services.anon),
					'anon.handleAnonInteraction'
					);
					if (handled) return;
				}
				if (matchId(parsedCustomId, 'welcome')) {
					await services.welcome.handleButton(interaction);
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
				if (parsedCustomId?.namespace === 'panel') {
					await services.panel.handleButton(interaction);
					return;
				}
			}

			if (interaction.type === InteractionType.ModalSubmit) {
				if (matchId(parsedCustomId, 'ann')) {
					const handled = await routeOrNotify(
					interaction,
					services.event?.handleAnnouncementInteraction?.bind(services.event),
					'event.handleAnnouncementInteraction'
					);
					if (handled) return;
				}
				if (matchId(parsedCustomId, 'evt')) {
					const handled = await routeOrNotify(
					interaction,
					services.event?.handleEventInteraction?.bind(services.event),
					'event.handleEventInteraction'
					);
					if (handled) return;
				}
				if (matchId(parsedCustomId, 'anon')) {
					const handled = await routeOrNotify(
					interaction,
					services.anon?.handleAnonInteraction?.bind(services.anon),
					'anon.handleAnonInteraction'
					);
					if (handled) return;
				}
				if (matchId(parsedCustomId, 'policy', 'modal', 'profile')) {
					await services.policy.handleProfileModal(interaction);
					return;
				}
				if (matchId(parsedCustomId, 'panel', 'role', 'create')) {
					await services.panel.handleModal(interaction);
					return;
				}
				if (matchId(parsedCustomId, 'req', 'editaccept')) {
					await services.policy.handleCreationRequestModal(interaction);
					return;
				}
				if (matchId(parsedCustomId, 'zone', 'request')) {
					await services.policy.handleZoneRequestModal(interaction);
					return;
				}
				if (matchId(parsedCustomId, 'welcome', 'request', 'modal')) {
					await services.welcome.handleModal(interaction);
					return;
				}
			}
		} finally {
			if (throttleKey && throttleService) {
				await throttleService.end(interaction.user.id, throttleKey).catch(() => {});
			}
		}
	}
};
