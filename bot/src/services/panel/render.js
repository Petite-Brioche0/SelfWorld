'use strict';

const {
	EmbedBuilder,
	ActionRowBuilder,
	ButtonBuilder,
	ButtonStyle,
	StringSelectMenuBuilder,
	ChannelType,
	PermissionFlagsBits,
} = require('discord.js');

// ===== Renderers — mixed into PanelService.prototype =====

/**
 * Renders the refresh/overview panel message for a zone.
 * @param {object} zoneRow - Zone database row
 * @returns {Promise<{ embed, components }>}
 */
async function renderRefresh(zoneRow) {
	let resolvedColor = 0x5865f2;
	try {
		resolvedColor = await this._resolveZoneColor(zoneRow);
	} catch { /* ignored */ }

	const embed = new EmbedBuilder()
		.setTitle('🛠️ Panneau à jour ?')
		.setDescription(
			'Il arrive que le panneau mette quelques minutes à refléter les changements. Si quelque chose paraît bloqué, utilise le bouton ci-dessous pour forcer une actualisation immédiate.'
		)
		.setColor(resolvedColor || 0x5865f2);

	const row = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`panel:refresh:${zoneRow.id}`)
			.setLabel('🔄 Actualiser maintenant')
			.setStyle(ButtonStyle.Secondary)
	);

	return { embed, components: [row] };
}

/**
 * Renders the members management panel message for a zone.
 * @param {object} zoneRow - Zone database row
 * @param {string|null} [selectedMemberId] - Currently selected member ID in the select menu
 * @param {{ confirmDeleteFor?: string }} [options]
 * @returns {Promise<{ embed, components }>}
 */
async function renderMembers(zoneRow, selectedMemberId = null, options = {}) {
	const { confirmKickFor = null } = options;
	const { guild, members } = await this._collectZoneMembers(zoneRow);
	let selectedMember = null;
	if (selectedMemberId) {
		selectedMember = members.find((m) => m.id === selectedMemberId) || null;
	}

	const total = members.length;
	const preview = total
		? members
			.slice(0, 30)
			.map((m) => `• <@${m.id}>`)
			.join('\n') + (total > 30 ? `\n… et ${total - 30} autre(s)` : '')
		: 'Aucun membre.';

	const embed = new EmbedBuilder()
		.setColor(await this._resolveZoneColor(zoneRow, guild))
		.setTitle('👥 Membres de la zone')
		.setDescription(`${preview}\n\nSélectionne un membre pour afficher les actions.`)
		.setFooter({ text: `Total: ${total}` });

	if (selectedMember) {
		embed.addFields({ name: 'Membre sélectionné', value: `<@${selectedMember.id}>`, inline: false });
	}

	const select = new StringSelectMenuBuilder()
		.setCustomId(`panel:member:select:${zoneRow.id}`)
		.setPlaceholder('Choisis un membre à gérer')
		.setMinValues(1)
		.setMaxValues(1);

	const memberOptions = members.slice(0, 25).map((member) => ({
		label: member.displayName?.slice(0, 100) || member.user?.username?.slice(0, 100) || member.id,
		value: member.id,
		description: member.user?.tag?.slice(0, 100) || undefined,
		default: selectedMember ? member.id === selectedMember.id : false
	}));

	if (memberOptions.length) {
		select.addOptions(memberOptions);
	} else {
		select
			.setPlaceholder('Aucun membre disponible')
			.setDisabled(true)
			.addOptions({ label: 'Aucun membre', value: 'noop' });
	}

	const rows = [new ActionRowBuilder().addComponents(select)];

	if (selectedMember) {
		// Build multi-select of zone roles with current roles pre-selected
		const { coreRoles, customRoles } = await this._collectZoneRoles(zoneRow);
		const assignableZoneRoles = customRoles.map((entry) => ({
			role: entry.role,
			description: entry.row?.name ? `Personnalisé — ${entry.row.name}` : 'Rôle personnalisé'
		}));
		embed.setDescription(
			assignableZoneRoles.length
				? 'Gère les rôles de ce membre grâce au menu ci-dessous.'
				: 'Aucun rôle personnalisé à attribuer pour cette zone.'
		);

		const memberRoleIds = new Set(selectedMember.roles.cache?.map((r) => r.id) || []);
		// For display: include core + custom
		const displayRoles = [];
		if (coreRoles.owner) displayRoles.push({ role: coreRoles.owner });
		if (coreRoles.member) displayRoles.push({ role: coreRoles.member });
		for (const entry of customRoles) displayRoles.push({ role: entry.role });
		const currentDisplay = displayRoles.filter((zr) => memberRoleIds.has(zr.role.id));
		const list = currentDisplay.length
			? currentDisplay.map((zr) => `• <@&${zr.role.id}>`).join('\n')
			: 'Aucun rôle de la zone.';
		embed.addFields({ name: 'Rôles de la zone', value: list, inline: false });

		// Select zone roles excluding Owner/Member (managed automatically)
		const roleOptions = assignableZoneRoles.slice(0, 25).map((zr) => ({
			label: zr.role.name.slice(0, 100),
			value: zr.role.id,
			description: zr.description.slice(0, 100),
			default: memberRoleIds.has(zr.role.id)
		}));

		const assignSelect = new StringSelectMenuBuilder()
			.setCustomId(`panel:member:assignRole:${zoneRow.id}:${selectedMember.id}`)
			.setPlaceholder('Sélectionne les rôles de la zone')
			.setMinValues(0)
			.setMaxValues(roleOptions.length ? Math.min(25, roleOptions.length) : 1);

		if (roleOptions.length) {
			assignSelect.addOptions(roleOptions);
		} else {
			assignSelect
				.setPlaceholder('Aucun rôle disponible')
				.setDisabled(true)
				.addOptions({ label: 'Aucun rôle', value: 'noop' });
		}
		rows.push(new ActionRowBuilder().addComponents(assignSelect));

		const confirmState = confirmKickFor && selectedMember.id === confirmKickFor;
		const actionRow = new ActionRowBuilder();
		if (confirmState) {
			actionRow.addComponents(
				new ButtonBuilder()
					.setCustomId(`panel:member:kick-confirm:${zoneRow.id}:${selectedMember.id}`)
					.setLabel('Confirmer l\'exclusion')
					.setStyle(ButtonStyle.Danger),
				new ButtonBuilder()
					.setCustomId(`panel:member:kick-cancel:${zoneRow.id}:${selectedMember.id}`)
					.setLabel('Annuler')
					.setStyle(ButtonStyle.Secondary)
			);
		} else {
			actionRow.addComponents(
				new ButtonBuilder()
					.setCustomId(`panel:member:kick:${zoneRow.id}:${selectedMember.id}`)
					.setLabel('Exclure le membre')
					.setStyle(ButtonStyle.Danger)
			);
		}
		rows.push(actionRow);
	}

	return { embed, components: rows };
}

/**
 * Renders the roles management panel message for a zone.
 * @param {object} zoneRow - Zone database row
 * @param {string|null} [selectedRoleId] - Currently selected role ID in the select menu
 * @param {{ confirmDeleteFor?: string|null }} [options]
 * @returns {Promise<{ embed, components }>}
 */
async function renderRoles(zoneRow, selectedRoleId = null, { confirmDeleteFor = null } = {}) {
	const { guild, customRoles, coreRoles } = await this._collectZoneRoles(zoneRow);

	const embed = new EmbedBuilder().setColor(await this._resolveZoneColor(zoneRow, guild));

	const addButton = new ButtonBuilder()
		.setCustomId(`panel:role:add:${zoneRow.id}`)
		.setLabel('Ajouter un rôle')
		.setStyle(ButtonStyle.Success);

	const rows = [new ActionRowBuilder().addComponents(addButton)];

	const select = new StringSelectMenuBuilder()
		.setCustomId(`panel:role:select:${zoneRow.id}`)
		.setPlaceholder('Choisis un rôle personnalisé')
		.setMinValues(1)
		.setMaxValues(1);

	const selectOptions = customRoles.slice(0, 25).map((entry) => ({
		label: entry.role.name.slice(0, 100),
		value: entry.role.id,
		description: entry.row?.name ? `Personnalisé — ${entry.row.name}` : 'Rôle personnalisé',
		default: selectedRoleId ? entry.role.id === selectedRoleId : false
	}));

	if (selectOptions.length) {
		select.addOptions(selectOptions);
	} else {
		select
			.setPlaceholder('Aucun rôle personnalisé')
			.setDisabled(true)
			.addOptions({ label: 'Aucun rôle', value: 'noop' });
	}

	rows.push(new ActionRowBuilder().addComponents(select));

	const selectedEntry = selectedRoleId
		? customRoles.find((entry) => entry.role.id === selectedRoleId) || null
		: null;

	if (!selectedEntry) {
		const coreLines = [
			coreRoles.owner ? `• Owner — <@&${coreRoles.owner.id}>` : '• Owner — (introuvable)',
			coreRoles.member ? `• Member — <@&${coreRoles.member.id}>` : '• Member — (introuvable)'
		].join('\n');

		const customLines = customRoles.length
			? customRoles
				.map((entry) => {
					const color = entry.row?.color || (entry.role.hexColor && entry.role.hexColor !== '#000000'
						? entry.role.hexColor
						: null);
					const colorSuffix = color ? ` \`${color}\`` : '';
					return `• <@&${entry.role.id}> — ${entry.row?.name || entry.role.name}${colorSuffix}`;
				})
				.join('\n')
			: 'Aucun rôle personnalisé.';

		embed
			.setTitle('🎭 Rôles de la zone')
			.setDescription(
				`${coreLines}\n\n__Rôles personnalisés__\n${customLines}\n\nUtilise le menu pour afficher les détails d'un rôle.`
			)
			.setFooter({ text: 'Max 10 rôles personnalisés' });

		return { embed, components: rows };
	}

	const { role, row } = selectedEntry;
	const color = row?.color || (role.hexColor && role.hexColor !== '#000000' ? role.hexColor : null);

	embed
		.setTitle(`🎭 Rôle : ${role.name}`)
		.setDescription(
			[
				`ID : \`${role.id}\``,
				`Couleur : ${color ? `\`${color}\`` : 'Aucune'}`,
				row?.name && row.name !== role.name ? `Nom interne : ${row.name}` : null
			]
				.filter(Boolean)
				.join('\n')
		);

	const { members: zoneMembers } = await this._collectZoneMembers(zoneRow);
	const zoneMemberMap = new Map(zoneMembers.map((m) => [m.id, m]));
	const assignedMembers = [...role.members.values()].filter((member) => zoneMemberMap.has(member.id));

	const preview = assignedMembers.length
		? assignedMembers
			.slice(0, 20)
			.map((member) => `• <@${member.id}>`)
			.join('\n') + (assignedMembers.length > 20 ? `\n… et ${assignedMembers.length - 20} autre(s)` : '')
		: 'Aucun membre ne possède ce rôle.';

	embed.addFields({ name: 'Membres possédant ce rôle', value: preview, inline: false });

	const memberOptions = zoneMembers.slice(0, 25).map((member) => ({
		label: member.displayName?.slice(0, 100) || member.user?.username?.slice(0, 100) || member.id,
		value: member.id,
		description: member.user?.tag?.slice(0, 100) || undefined,
		default: member.roles.cache?.has?.(role.id) || false
	}));

	const assignSelect = new StringSelectMenuBuilder()
		.setCustomId(`panel:role:members:${zoneRow.id}:${role.id}`)
		.setPlaceholder('Sélectionne les membres à qui attribuer ce rôle')
		.setMinValues(0)
		.setMaxValues(Math.min(25, memberOptions.length || 1));

	if (memberOptions.length) {
		assignSelect.addOptions(memberOptions);
	} else {
		assignSelect
			.setPlaceholder('Aucun membre disponible')
			.setDisabled(true)
			.addOptions({ label: 'Aucun membre', value: 'noop' });
	}

	rows.push(new ActionRowBuilder().addComponents(assignSelect));

	if (confirmDeleteFor === role.id) {
		rows.push(
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`panel:role:delete-confirm:${zoneRow.id}:${role.id}`)
					.setLabel('Confirmer la suppression')
					.setStyle(ButtonStyle.Danger),
				new ButtonBuilder()
					.setCustomId(`panel:role:delete-cancel:${zoneRow.id}:${role.id}`)
					.setLabel('Annuler')
					.setStyle(ButtonStyle.Secondary)
			)
		);
	} else {
		rows.push(
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`panel:role:modify:${zoneRow.id}:${role.id}`)
					.setLabel('Modifier le rôle')
					.setStyle(ButtonStyle.Primary),
				new ButtonBuilder()
					.setCustomId(`panel:role:delete:${zoneRow.id}:${role.id}`)
					.setLabel('Supprimer le rôle')
					.setStyle(ButtonStyle.Danger)
			)
		);
	}

	return { embed, components: rows };
}

/**
 * Renders the channels management panel message for a zone.
 * @param {object} zoneRow - Zone database row
 * @param {string|null} [selectedChannelId] - Currently selected channel ID in the select menu
 * @param {{ confirmDeleteFor?: string|null }} [options]
 * @returns {Promise<{ embed, components }>}
 */
async function renderChannels(zoneRow, selectedChannelId = null, { confirmDeleteFor = null } = {}) {
	const { guild, channels } = await this._collectZoneChannels(zoneRow);
	const { coreRoles, customRoles } = await this._collectZoneRoles(zoneRow);

	const embed = new EmbedBuilder().setColor(await this._resolveZoneColor(zoneRow, guild));

	const addRow = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`panel:ch:add:${zoneRow.id}`)
			.setLabel('Ajouter un salon')
			.setStyle(ButtonStyle.Success)
	);

	const select = new StringSelectMenuBuilder()
		.setCustomId(`panel:ch:select:${zoneRow.id}`)
		.setPlaceholder('Choisis un salon à gérer')
		.setMinValues(1)
		.setMaxValues(1);

	const manageableChannels = channels.filter((entry) => !entry.isProtected);
	const selectOptions = manageableChannels.slice(0, 25).map((entry) => ({
		label: entry.channel.name.slice(0, 100),
		value: entry.channel.id,
		description:
			entry.channel.type === ChannelType.GuildVoice
				? 'Salon vocal de la zone'
				: 'Salon textuel de la zone',
		default: selectedChannelId ? entry.channel.id === selectedChannelId : false
	}));

	if (selectOptions.length) {
		select.addOptions(selectOptions);
	} else {
		select
			.setPlaceholder('Aucun salon disponible')
			.setDisabled(true)
			.addOptions({ label: 'Aucun salon', value: 'noop' });
	}

	const rows = [addRow, new ActionRowBuilder().addComponents(select)];

	const selectedEntry = selectedChannelId
		? manageableChannels.find((entry) => entry.channel.id === selectedChannelId) || null
		: null;

	if (!selectedEntry) {
		const textChannels = channels.filter((entry) => entry.channel.type === ChannelType.GuildText);
		const voiceChannels = channels.filter((entry) => entry.channel.type === ChannelType.GuildVoice);

		const renderList = (list) =>
			list.length
				? list
					.map((entry) => {
						const prefix = entry.channel.type === ChannelType.GuildVoice ? '🔊' : '#';
						const protectedSuffix = entry.isProtected ? ' — 🔒 protégé' : '';
						return `• ${prefix}${entry.channel.name}${protectedSuffix}`;
					})
					.join('\n')
				: 'Aucun salon.';

		embed
			.setTitle('🧭 Salons de la zone')
			.setDescription('Sélectionne un salon pour consulter ses détails et ses permissions.')
			.addFields(
				{ name: 'Textuels', value: renderList(textChannels).slice(0, 1024), inline: false },
				{ name: 'Vocaux', value: renderList(voiceChannels).slice(0, 1024), inline: false }
			);

		return { embed, components: rows };
	}

	const { channel, isProtected } = selectedEntry;
	const typeLabel = channel.type === ChannelType.GuildVoice ? 'Vocal' : 'Textuel';
	const description =
		channel.type === ChannelType.GuildText
			? channel.topic?.trim()?.slice(0, 1024) || 'Aucune description.'
			: 'Les salons vocaux n\'ont pas de description.';

	embed
		.setTitle(`🧭 Salon : ${channel.name}`)
		.setDescription(
			isProtected
				? 'Ce salon est protégé. Seules certaines actions sont autorisées.'
				: 'Gère le nom, la description et les permissions de ce salon.'
		)
		.addFields(
			{ name: 'Type', value: typeLabel, inline: true },
			{ name: 'Protégé', value: isProtected ? 'Oui' : 'Non', inline: true },
			{ name: 'Description', value: description, inline: false }
		);

	const overwrites = channel.permissionOverwrites?.cache || new Map();
	const allowedRoleIds = new Set();
	for (const overwrite of overwrites.values()) {
		if (!overwrite) continue;
		if (overwrite.type !== 0) continue; // Only role overwrites
		if (overwrite.allow.has(PermissionFlagsBits.ViewChannel)) {
			allowedRoleIds.add(overwrite.id);
			continue;
		}
		if (
			channel.type === ChannelType.GuildVoice &&
			(overwrite.allow.has(PermissionFlagsBits.Connect) || overwrite.allow.has(PermissionFlagsBits.Speak))
		) {
			allowedRoleIds.add(overwrite.id);
		}
	}

	if (zoneRow.role_owner_id) allowedRoleIds.add(zoneRow.role_owner_id);

	const zoneRoleMetas = [];
	if (coreRoles.owner) zoneRoleMetas.push({ role: coreRoles.owner, label: 'Owner' });
	if (coreRoles.member) zoneRoleMetas.push({ role: coreRoles.member, label: 'Membres' });
	for (const entry of customRoles) {
		zoneRoleMetas.push({ role: entry.role, label: entry.row?.name || entry.role.name });
	}

	const allowedRolesList = zoneRoleMetas
		.filter((meta) => allowedRoleIds.has(meta.role.id))
		.map((meta) => `• <@&${meta.role.id}>`);

	embed.addFields({
		name: 'Rôles autorisés',
		value: allowedRolesList.length ? allowedRolesList.join('\n') : 'Aucun rôle autorisé pour le moment.',
		inline: false
	});

	const permissionOptions = [];
	if (coreRoles.member) {
		permissionOptions.push({
			id: coreRoles.member.id,
			label: coreRoles.member.name.slice(0, 100),
			description: 'Rôle membre de la zone'
		});
	}
	for (const entry of customRoles) {
		permissionOptions.push({
			id: entry.role.id,
			label: entry.role.name.slice(0, 100),
			description: entry.row?.name ? `Personnalisé — ${entry.row.name}` : 'Rôle personnalisé'
		});
	}

	const permSelect = new StringSelectMenuBuilder()
		.setCustomId(`panel:ch:roles:${zoneRow.id}:${channel.id}`)
		.setPlaceholder('Choisis les rôles autorisés dans ce salon')
		.setMinValues(0)
		.setMaxValues(Math.min(25, permissionOptions.length || 1));

	if (permissionOptions.length && !isProtected) {
		permSelect.addOptions(
			permissionOptions.map((option) => ({
				label: option.label,
				value: option.id,
				description: option.description,
				default: allowedRoleIds.has(option.id)
			}))
		);
	} else {
		permSelect
			.setPlaceholder(isProtected ? 'Salon protégé — permissions figées' : 'Aucun rôle configurable')
			.setDisabled(true)
			.addOptions({ label: 'Indisponible', value: 'noop' });
	}

	rows.push(new ActionRowBuilder().addComponents(permSelect));

	if (confirmDeleteFor === channel.id) {
		rows.push(
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`panel:ch:delete-confirm:${zoneRow.id}:${channel.id}`)
					.setLabel('Confirmer la suppression')
					.setStyle(ButtonStyle.Danger),
				new ButtonBuilder()
					.setCustomId(`panel:ch:delete-cancel:${zoneRow.id}:${channel.id}`)
					.setLabel('Annuler')
					.setStyle(ButtonStyle.Secondary)
			)
		);
	} else {
		rows.push(
			new ActionRowBuilder().addComponents(
				new ButtonBuilder()
					.setCustomId(`panel:ch:modify:${zoneRow.id}:${channel.id}`)
					.setLabel('Modifier le salon')
					.setStyle(ButtonStyle.Primary)
					.setDisabled(isProtected),
				new ButtonBuilder()
					.setCustomId(`panel:ch:delete:${zoneRow.id}:${channel.id}`)
					.setLabel('Supprimer le salon')
					.setStyle(ButtonStyle.Danger)
					.setDisabled(isProtected)
			)
		);
	}

	return { embed, components: rows };
}

/**
 * Renders the policy management panel message for a zone.
 * @param {object} zoneRow - Zone database row
 * @returns {Promise<{ embed, components }>}
 */
async function renderPolicy(zoneRow) {
	const policy = zoneRow.policy || 'closed';
	const helperMap = {
		open: 'Accès immédiat pour toute personne qui clique sur « Rejoindre ».',
		ask: 'Les nouvelles personnes doivent passer par une demande ou un code.',
		closed: 'Aucun accès public — uniquement les membres actuels.'
	};

	let resolvedColor = 0x5865f2;
	try {
		resolvedColor = await this._resolveZoneColor(zoneRow);
	} catch { /* ignored */ }

	const embed = new EmbedBuilder()
		.setColor(resolvedColor)
		.setTitle('🔐 Politique d\'entrée')
		.setDescription(
			`Politique actuelle : **${policy}**\n${helperMap[policy] || ''}`.trim()
		);

	if (policy === 'ask') {
		const mode = zoneRow.ask_join_mode || 'request';
		const approver = zoneRow.ask_approver_mode || 'owner';
		embed.addFields(
			{
				name: 'Mode de demande',
				value:
					mode === 'both'
						? 'Demande ou code'
						: mode === 'invite'
						? 'Codes uniquement'
						: 'Demande classique',
				inline: false
			},
			{
				name: 'Décideur',
				value: approver === 'members' ? 'Membres de la zone' : 'Owner uniquement',
				inline: false
			}
		);
	}

	const profileTitle = zoneRow.profile_title || zoneRow.name || 'Profil public';
	const profileDesc = zoneRow.profile_desc?.trim() ||
		'Aucune description configurée pour l\'instant.';
	embed.addFields(
		{ name: 'Titre public', value: profileTitle.slice(0, 100), inline: false },
		{ name: 'Description', value: profileDesc.slice(0, 200), inline: false }
	);

	const tags = Array.isArray(zoneRow.profile_tags)
		? zoneRow.profile_tags
		: this._parseTags(zoneRow.profile_tags);
	if (tags?.length) {
		embed.addFields({ name: 'Tags', value: tags.map((tag) => `#${tag}`).join(' · '), inline: false });
	}

	if (policy === 'open') {
		const activityService = this._getActivityService();
		if (activityService?.getZoneActivityScore && activityService?.buildProgressBar) {
			try {
				const score = await activityService.getZoneActivityScore(zoneRow.id, 14);
				const bar = activityService.buildProgressBar(score);
				const pct = (score * 100) | 0;
				embed.addFields({ name: 'Activité (14j)', value: `${bar}  ${pct}%`, inline: false });
			} catch (err) {
				this.logger?.warn({ err, zoneId: zoneRow.id }, 'Failed to compute zone activity score');
			}
		}
	}

	const components = [];

	const policySelect = new StringSelectMenuBuilder()
		.setCustomId(`panel:policy:set:${zoneRow.id}`)
		.setPlaceholder('Choisir une politique…')
		.setMinValues(1)
		.setMaxValues(1)
		.addOptions(
			['open', 'ask', 'closed'].map((value) => ({
				label: value,
				value,
				default: value === policy
			}))
		);
	components.push(new ActionRowBuilder().addComponents(policySelect));

	const buttonRow = new ActionRowBuilder().addComponents(
		new ButtonBuilder()
			.setCustomId(`panel:policy:profile:${zoneRow.id}`)
			.setLabel('Personnaliser le profil public')
			.setStyle(ButtonStyle.Primary)
	);
	components.push(buttonRow);

	if (policy === 'ask') {
		const joinModeSelect = new StringSelectMenuBuilder()
			.setCustomId(`panel:policy:askmode:${zoneRow.id}`)
			.setPlaceholder('Mode de demande…')
			.setMinValues(1)
			.setMaxValues(1)
			.addOptions([
				{
					label: 'Sur demande',
					value: 'request',
					description: 'Les personnes soumettent une demande classique.',
					default: (zoneRow.ask_join_mode || 'request') === 'request'
				},
				{
					label: 'Sur invitation',
					value: 'invite',
					description: 'Accès via codes générés.',
					default: zoneRow.ask_join_mode === 'invite'
				},
				{
					label: 'Les deux',
					value: 'both',
					description: 'Demande ou code, selon la situation.',
					default: zoneRow.ask_join_mode === 'both'
				}
			]);

		const approverSelect = new StringSelectMenuBuilder()
			.setCustomId(`panel:policy:approver:${zoneRow.id}`)
			.setPlaceholder('Qui approuve ?')
			.setMinValues(1)
			.setMaxValues(1)
			.addOptions([
				{
					label: 'Owner',
					value: 'owner',
					description: 'Le propriétaire tranche chaque demande.',
					default: (zoneRow.ask_approver_mode || 'owner') === 'owner'
				},
				{
					label: 'Membres',
					value: 'members',
					description: 'La communauté décide dans #reception.',
					default: zoneRow.ask_approver_mode === 'members'
				}
			]);

		components.push(new ActionRowBuilder().addComponents(joinModeSelect));
		components.push(new ActionRowBuilder().addComponents(approverSelect));
	}

	return { embed, components };
}

module.exports = {
	renderRefresh,
	renderMembers,
	renderRoles,
	renderChannels,
	renderPolicy,
};
