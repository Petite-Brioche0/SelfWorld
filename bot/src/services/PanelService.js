const {
EmbedBuilder,
ActionRowBuilder,
ButtonBuilder,
ButtonStyle,
StringSelectMenuBuilder,
ModalBuilder,
TextInputBuilder,
TextInputStyle,
ChannelType,
PermissionFlagsBits
} = require('discord.js');

class PanelService {
	#schemaReady = false;
	constructor(client, db, logger = null) {
		this.client = client;
		this.db = db;
		this.logger = logger;
	}

	async renderInitialPanel({ zone }) {
		if (!zone?.id) return;
		try {
			await this.refresh(zone.id, ['members', 'roles', 'channels', 'policy']);
		} catch (err) {
			this.logger?.warn({ err, zoneId: zone?.id }, 'Failed to render initial panel');
		}
	}

	async ensurePanel(zoneRow) {
		await this.#ensureSchema();
		const channel = await this.#fetchChannel(zoneRow.text_panel_id);
		if (!channel) throw new Error('panel channel missing');

		// ensure record
		let [rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		if (!rows.length) {
			await this.db.query('INSERT INTO panel_messages(zone_id) VALUES (?)', [zoneRow.id]);
			[rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		}
		let record = rows[0];

		const map = {
			members: { column: 'members_msg_id', render: () => this.renderMembers(zoneRow) },
			roles:   { column: 'roles_msg_id', render: () => this.renderRoles(zoneRow) },
			channels:{ column: 'channels_msg_id', render: () => this.renderChannels(zoneRow) },
			policy:  { column: 'policy_msg_id', render: () => this.renderPolicy(zoneRow) }
		};

		const messages = {};

		for (const [key, meta] of Object.entries(map)) {
			const { embed, components } = await meta.render();
			let msgId = record[meta.column];
			let message = null;

			if (msgId) {
				try {
					message = await channel.messages.fetch(msgId);
					await message.edit({ embeds: [embed], components });
				} catch {
					message = await channel.send({ embeds: [embed], components });
				}
			} else {
				message = await channel.send({ embeds: [embed], components });
				msgId = message.id;
				await this.db.query(`UPDATE panel_messages SET ${meta.column} = ? WHERE zone_id = ?`, [msgId, zoneRow.id]);
				record = { ...record, [meta.column]: msgId };
			}
			messages[key] = { message, id: msgId };
		}

		return { channel, record, messages };
	}

	async refresh(zoneId, sections = []) {
		await this.#ensureSchema();
		const zoneRow = await this.#getZone(zoneId);
		if (!zoneRow) throw new Error('zone not found');
		const channel = await this.#fetchChannel(zoneRow.text_panel_id);
		if (!channel) throw new Error('panel channel missing');

		let [recordRows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		if (!recordRows.length) {
			await this.db.query('INSERT INTO panel_messages(zone_id) VALUES (?)', [zoneRow.id]);
			[recordRows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id=?', [zoneRow.id]);
		}
		const record = recordRows[0];

		if (!sections.length) sections = ['members','roles','channels','policy'];

		const map = {
			members: { column: 'members_msg_id', render: () => this.renderMembers(zoneRow) },
			roles:   { column: 'roles_msg_id', render: () => this.renderRoles(zoneRow) },
			channels:{ column: 'channels_msg_id', render: () => this.renderChannels(zoneRow) },
			policy:  { column: 'policy_msg_id', render: () => this.renderPolicy(zoneRow) }
		};

		for (const key of sections) {
			const meta = map[key];
			if (!meta) continue;
			const { embed, components } = await meta.render();
			let msgId = record[meta.column];
			if (!msgId) {
				const m = await channel.send({ embeds: [embed], components });
				msgId = m.id;
				await this.db.query(`UPDATE panel_messages SET ${meta.column}=? WHERE zone_id=?`, [msgId, zoneRow.id]);
				continue;
			}
			try {
				const msg = await channel.messages.fetch(msgId);
				await msg.edit({ embeds: [embed], components });
			} catch {
				const m = await channel.send({ embeds: [embed], components });
				await this.db.query(`UPDATE panel_messages SET ${meta.column}=? WHERE zone_id=?`, [m.id, zoneRow.id]);
			}
		}
	}

	// ===== Renderers

	async renderMembers(zoneRow, selectedMemberId = null, { assignMode = false } = {}) {
	        const { guild, members } = await this.#collectZoneMembers(zoneRow);
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
	                .setColor(await this.#resolveZoneColor(zoneRow, guild))
	                .setTitle('👥 Membres de la zone')
	                .setDescription(`${preview}\n\nSélectionne un membre pour afficher les actions.`)
	                .setFooter({ text: `Total: ${total}` });
	
	        if (selectedMember) {
	                embed.addFields({ name: 'Membre sélectionné', value: `<@${selectedMember.id}>`, inline: false });
	        }

                const select = new StringSelectMenuBuilder()
                        .setCustomId(`panel:member:view:${zoneRow.id}`)
                        .setPlaceholder('Choisis un membre à gérer')
                        .setMinValues(1)
                        .setMaxValues(1);

                const options = members.slice(0, 25).map((member) => ({
                        label: member.displayName?.slice(0, 100) || member.user?.username?.slice(0, 100) || member.id,
                        value: member.id,
                        description: member.user?.tag?.slice(0, 100) || undefined,
                        default: selectedMember ? member.id === selectedMember.id : false
                }));

                if (options.length) {
                        select.addOptions(options);
                } else {
                        select
                                .setPlaceholder('Aucun membre disponible')
                                .setDisabled(true)
                                .addOptions({ label: 'Aucun membre', value: 'noop' });
                }
	
	        const rows = [new ActionRowBuilder().addComponents(select)];
	
	        if (selectedMember) {
	                if (assignMode) {
	                        // Build multi-select of zone roles with current roles pre-selected
	                        const { coreRoles, customRoles } = await this.#collectZoneRoles(zoneRow);
	                        const customZoneRoles = [];
	                        for (const entry of customRoles) customZoneRoles.push({ role: entry.role, description: entry.row?.name ? `Personnalisé — ${entry.row.name}` : 'Rôle personnalisé' });

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
	                        embed.addFields({ name: 'Rôles de la zone (actuels)', value: list, inline: false });

	                        // Select only custom roles (core roles are managed automatically)
	                        const options = customZoneRoles.slice(0, 25).map((zr) => ({
	                                label: zr.role.name.slice(0, 100),
	                                value: zr.role.id,
	                                description: zr.description.slice(0, 100),
	                                default: memberRoleIds.has(zr.role.id)
	                        }));

	                        const assignSelect = new StringSelectMenuBuilder()
	                                .setCustomId(`panel:member:roles:${zoneRow.id}:${selectedMember.id}`)
	                                .setPlaceholder('Sélectionne les rôles de la zone')
	                                .setMinValues(0)
	                                .setMaxValues(Math.min(25, options.length || 1));

	                        if (options.length) {
	                                assignSelect.addOptions(options);
	                        } else {
	                                assignSelect
	                                        .setPlaceholder('Aucun rôle disponible')
	                                        .setDisabled(true)
	                                        .addOptions({ label: 'Aucun rôle', value: 'noop' });
	                        }
	                        rows.push(new ActionRowBuilder().addComponents(assignSelect));

	                        // Actions row (keep Kick + Back)
	                        rows.push(
	                                new ActionRowBuilder().addComponents(
	                                        new ButtonBuilder()
	                                                .setCustomId(`panel:member:kick:${zoneRow.id}:${selectedMember.id}`)
	                                                .setLabel('Exclure')
	                                                .setStyle(ButtonStyle.Danger),
	                                        new ButtonBuilder()
	                                                .setCustomId(`panel:member:view:${zoneRow.id}`)
	                                                .setLabel('Retour')
	                                                .setStyle(ButtonStyle.Secondary)
	                                )
	                        );
	                } else {
	                        rows.push(
	                                new ActionRowBuilder().addComponents(
	                                        new ButtonBuilder()
	                                                .setCustomId(`panel:member:kick:${zoneRow.id}:${selectedMember.id}`)
	                                                .setLabel('Exclure')
	                                                .setStyle(ButtonStyle.Danger),
	                                        new ButtonBuilder()
	                                                .setCustomId(`panel:member:assign:${zoneRow.id}:${selectedMember.id}`)
	                                                .setLabel('Attribuer un rôle')
	                                                .setStyle(ButtonStyle.Primary)
	                                )
	                        );
	                }
	        }
	
	        return { embed, components: rows };
	}

        async renderRoles(zoneRow, selectedRoleId = null, { confirmDeleteFor = null } = {}) {
                const { guild, customRoles, coreRoles } = await this.#collectZoneRoles(zoneRow);

                const embed = new EmbedBuilder().setColor(await this.#resolveZoneColor(zoneRow, guild));

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
                                        `${coreLines}\n\n__Rôles personnalisés__\n${customLines}\n\nUtilise le menu pour afficher les détails d’un rôle.`
                                )
                                .setFooter({ text: 'Max 10 rôles personnalisés' });

                        return { embed, components: rows };
                }

                const { role, row } = selectedEntry;
                const color = row?.color || (role.hexColor && role.hexColor !== '#000000' ? role.hexColor : null);

                embed
                        .setTitle(`🎭 Rôle : ${role.name}`)
                        .setDescription(
                                [
                                        `ID : \`${role.id}\``,
                                        `Couleur : ${color ? `\`${color}\`` : 'Aucune'}`,
                                        row?.name && row.name !== role.name ? `Nom interne : ${row.name}` : null
                                ]
                                        .filter(Boolean)
                                        .join('\n')
                        );

                const { members: zoneMembers } = await this.#collectZoneMembers(zoneRow);
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

        async renderChannels(zoneRow, selectedChannelId = null, { confirmDeleteFor = null } = {}) {
                const { guild, channels } = await this.#collectZoneChannels(zoneRow);
                const { coreRoles, customRoles } = await this.#collectZoneRoles(zoneRow);

                const embed = new EmbedBuilder().setColor(await this.#resolveZoneColor(zoneRow, guild));

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

                const selectOptions = channels.slice(0, 25).map((entry) => ({
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
                        ? channels.find((entry) => entry.channel.id === selectedChannelId) || null
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
                                : 'Les salons vocaux n’ont pas de description.';

                embed
                        .setTitle(`🧭 Salon : ${channel.name}`)
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

	async renderPolicy(zoneRow) {
		const embed = new EmbedBuilder()
			.setColor(0x3498db)
			.setTitle('🔐 Politique d’entrée')
			.setDescription(`Politique actuelle : **${zoneRow.policy || 'closed'}**\nTypes: \`closed\`, \`ask\`, \`invite\`, \`open\``);

		const row = new ActionRowBuilder().addComponents(
			new StringSelectMenuBuilder()
				.setCustomId(`panel:policy:set:${zoneRow.id}`)
				.setPlaceholder('Changer la politique…')
				.addOptions([
					{ label: 'closed', value: 'closed' },
					{ label: 'ask', value: 'ask' },
					{ label: 'invite', value: 'invite' },
					{ label: 'open', value: 'open' }
				])
		);

		return { embed, components: [row] };
	}

	// ===== helpers

	async #getZone(zoneId) {
		const [rows] = await this.db.query('SELECT * FROM zones WHERE id=?', [zoneId]);
		return rows?.[0] || null;
	}

async #fetchChannel(id) {
if (!id) return null;
try { return await this.client.channels.fetch(id); } catch { return null; }
}

	async #collectZoneMembers(zoneRow) {
	const guild = await this.client.guilds.fetch(zoneRow.guild_id);
	const memberIds = new Map();
	
	const collect = async (roleId) => {
	if (!roleId) return;
	const role = await guild.roles.fetch(roleId).catch(() => null);
	if (!role) return;
	for (const member of role.members.values()) {
	memberIds.set(member.id, member);
	}
	};
	
	await collect(zoneRow.role_member_id);
	await collect(zoneRow.role_owner_id);
	
	const members = [...memberIds.values()].sort((a, b) => {
	const nameA = a.displayName?.toLowerCase?.() || a.user?.username?.toLowerCase?.() || '';
	const nameB = b.displayName?.toLowerCase?.() || b.user?.username?.toLowerCase?.() || '';
	return nameA.localeCompare(nameB, 'fr', { sensitivity: 'base' });
	});
	
	return { guild, members };
	}

	async #collectZoneRoles(zoneRow) {
	const guild = await this.client.guilds.fetch(zoneRow.guild_id);
	const ownerRole = await guild.roles.fetch(zoneRow.role_owner_id).catch(() => null);
	const memberRole = await guild.roles.fetch(zoneRow.role_member_id).catch(() => null);
	
	let [customRows] = await this.db.query(
	'SELECT role_id, name, color FROM zone_roles WHERE zone_id = ? ORDER BY name ASC',
	[zoneRow.id]
	);
	customRows = Array.isArray(customRows) ? customRows : [];
	
	const customRoles = [];
	for (const row of customRows) {
	const role = await guild.roles.fetch(row.role_id).catch(() => null);
	if (!role) continue;
	customRoles.push({ role, row });
	}
	
	return {
	guild,
	coreRoles: {
	owner: ownerRole,
	member: memberRole
	},
	customRoles
	};
	}

	async #collectZoneChannels(zoneRow) {
		const guild = await this.client.guilds.fetch(zoneRow.guild_id);
		const category = await this.#fetchChannel(zoneRow.category_id);
		if (!category) {
			return { guild, channels: [] };
		}

		const protectedIds = new Set(
			[
				zoneRow.text_panel_id,
				zoneRow.text_reception_id,
				zoneRow.text_anon_id,
				zoneRow.voice_id
			].filter(Boolean)
		);

		const fetched = await guild.channels.fetch();
		const channels = [...fetched.values()]
			.filter((channel) => channel?.parentId === category.id)
			.map((channel) => ({ channel, isProtected: protectedIds.has(channel.id) }))
			.sort((a, b) => a.channel.rawPosition - b.channel.rawPosition);

		return { guild, channels };
	}

	#buildChannelPermissionOverwrites(guild, zoneRow, channel, allowedRoleIds, botRole = null) {
		const overwrites = [];
		const everyoneRole = guild.roles.everyone;
		if (everyoneRole) {
			overwrites.push({ id: everyoneRole.id, deny: [PermissionFlagsBits.ViewChannel] });
		}

		const textAllow = [
			PermissionFlagsBits.ViewChannel,
			PermissionFlagsBits.SendMessages,
			PermissionFlagsBits.ReadMessageHistory
		];
		const voiceAllow = [
			PermissionFlagsBits.ViewChannel,
			PermissionFlagsBits.Connect,
			PermissionFlagsBits.Speak
		];

		const ownerAllow = channel.type === ChannelType.GuildVoice
			? [...voiceAllow, PermissionFlagsBits.ManageChannels]
			: [...textAllow, PermissionFlagsBits.ManageChannels];
		if (zoneRow.role_owner_id) {
			overwrites.push({ id: zoneRow.role_owner_id, allow: ownerAllow });
		}

		const unique = new Set(allowedRoleIds || []);
		unique.delete(zoneRow.role_owner_id);
		for (const roleId of unique) {
			if (!roleId) continue;
			const allow = channel.type === ChannelType.GuildVoice ? voiceAllow : textAllow;
			overwrites.push({ id: roleId, allow });
		}

		if (zoneRow.role_muted_id) {
			const deny = channel.type === ChannelType.GuildVoice
				? [PermissionFlagsBits.Speak, PermissionFlagsBits.Connect]
				: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.AddReactions];
			overwrites.push({ id: zoneRow.role_muted_id, deny });
		}

		if (botRole) {
			const allow = channel.type === ChannelType.GuildVoice
				? [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.Connect,
					PermissionFlagsBits.Speak,
					PermissionFlagsBits.MoveMembers,
					PermissionFlagsBits.MuteMembers,
					PermissionFlagsBits.DeafenMembers,
					PermissionFlagsBits.ManageChannels
				]
				: [
					PermissionFlagsBits.ViewChannel,
					PermissionFlagsBits.SendMessages,
					PermissionFlagsBits.ReadMessageHistory,
					PermissionFlagsBits.ManageChannels,
					PermissionFlagsBits.ManageMessages
				];
			overwrites.push({ id: botRole.id, allow });
		}

return overwrites;
}

#normalizeColor(value) {
if (!value) return null;
let input = value.trim();
if (!input.length) return null;
if (input.startsWith('#')) input = input.slice(1);
if (!/^[0-9a-fA-F]{6}$/.test(input)) return null;
return `#${input.toUpperCase()}`;
}

#parseChannelType(raw) {
if (!raw) return null;
const input = raw.trim().toLowerCase();
if (['text', 'texte', 'txt'].includes(input)) return ChannelType.GuildText;
if (['voice', 'vocal', 'voc', 'voicechannel'].includes(input)) return ChannelType.GuildVoice;
return null;
}

async #resolveZoneColor(zoneRow, guild = null) {
	try {
	const g = guild || (await this.client.guilds.fetch(zoneRow.guild_id));
	if (zoneRow.role_owner_id) {
	const ownerRole = await g.roles.fetch(zoneRow.role_owner_id).catch(() => null);
	if (ownerRole?.color) return ownerRole.color;
	}
	if (zoneRow.role_member_id) {
	const memberRole = await g.roles.fetch(zoneRow.role_member_id).catch(() => null);
	if (memberRole?.color) return memberRole.color;
	}
	} catch {}
	return 0x5865f2;
	}

async handleSelectMenu(interaction) {
const id = interaction.customId || '';
if (!id.startsWith('panel:')) return false;

const parts = id.split(':');
const zoneId = Number(parts[3] || parts.at(-1));
if (!zoneId) {
await interaction.reply({ content: 'Zone invalide.', ephemeral: true }).catch(() => {});
return true;
}

const zoneRow = await this.#getZone(zoneId);
if (!zoneRow) {
await interaction.reply({ content: 'Zone introuvable.', ephemeral: true }).catch(() => {});
return true;
}

if (interaction.user.id !== String(zoneRow.owner_user_id)) {
await interaction.reply({ content: 'Tu ne peux pas gérer cette zone.', ephemeral: true }).catch(() => {});
return true;
}

if (parts[1] === 'member' && parts[2] === 'view') {
const selectedId = interaction.values?.[0];
const { embed, components } = await this.renderMembers(zoneRow, selectedId);
await interaction.update({ embeds: [embed], components }).catch(() => {});
return true;
}

if (parts[1] === 'member' && parts[2] === 'roles') {
const memberId = parts[4];
if (!memberId) {
await interaction.reply({ content: 'Membre invalide.', ephemeral: true }).catch(() => {});
return true;
}
const values = interaction.values || [];
await interaction.deferUpdate().catch(() => {});
try {
const { guild, members } = await this.#collectZoneMembers(zoneRow);
const member = members.find((m) => m.id === memberId) || (await guild.members.fetch(memberId).catch(() => null));
if (!member) throw new Error('member not found');

const { customRoles } = await this.#collectZoneRoles(zoneRow);
const allowedIds = new Set(customRoles.map((entry) => entry.role.id));

const desired = new Set(values.filter((v) => allowedIds.has(v)));
const current = new Set(
(member.roles?.cache ? [...member.roles.cache.keys()] : []).filter((id) => allowedIds.has(id))
);

const toAdd = [...desired].filter((id) => !current.has(id));
const toRemove = [...current].filter((id) => !desired.has(id));

if (toAdd.length) {
await member.roles.add(toAdd).catch(() => {});
}
if (toRemove.length) {
await member.roles.remove(toRemove).catch(() => {});
}

const { embed, components } = await this.renderMembers(zoneRow, memberId, { assignMode: true });
await interaction.message.edit({ embeds: [embed], components }).catch(() => {});
} catch (err) {
await interaction.followUp?.({ content: 'Impossible de mettre à jour les rôles.', ephemeral: true }).catch(() => {});
}
return true;
}

if (parts[1] === 'role' && parts[2] === 'select') {
const selectedRoleId = interaction.values?.[0] || null;
const { embed, components } = await this.renderRoles(zoneRow, selectedRoleId);
await interaction.update({ embeds: [embed], components }).catch(() => {});
return true;
}

if (parts[1] === 'role' && parts[2] === 'members') {
const roleId = parts[4];
if (!roleId) {
await interaction.reply({ content: 'Rôle invalide.', ephemeral: true }).catch(() => {});
return true;
}
await interaction.deferUpdate().catch(() => {});
try {
const { guild } = await this.#collectZoneRoles(zoneRow);
const role = await guild.roles.fetch(roleId).catch(() => null);
if (!role) throw new Error('role not found');

const { members: zoneMembers } = await this.#collectZoneMembers(zoneRow);
const zoneMemberMap = new Map(zoneMembers.map((member) => [member.id, member]));
const selectedIds = new Set((interaction.values || []).filter((value) => zoneMemberMap.has(value)));

const currentAssignments = new Set(
[...role.members.values()].filter((member) => zoneMemberMap.has(member.id)).map((member) => member.id)
);

const toAdd = [...selectedIds].filter((id) => !currentAssignments.has(id));
const toRemove = [...currentAssignments].filter((id) => !selectedIds.has(id));

for (const memberId of toAdd) {
const member = zoneMemberMap.get(memberId);
if (member) await member.roles.add(role).catch(() => {});
}

for (const memberId of toRemove) {
const member = zoneMemberMap.get(memberId) || (await guild.members.fetch(memberId).catch(() => null));
if (member) await member.roles.remove(role).catch(() => {});
}

const { embed, components } = await this.renderRoles(zoneRow, roleId);
await interaction.message.edit({ embeds: [embed], components }).catch(() => {});
} catch (err) {
await interaction.followUp?.({ content: 'Impossible de mettre à jour les membres du rôle.', ephemeral: true }).catch(() => {});
}
return true;
}

if (parts[1] === 'ch' && parts[2] === 'select') {
const channelId = interaction.values?.[0] || null;
const { embed, components } = await this.renderChannels(zoneRow, channelId);
await interaction.update({ embeds: [embed], components }).catch(() => {});
return true;
}

if (parts[1] === 'ch' && parts[2] === 'roles') {
const channelId = parts[4];
if (!channelId) {
await interaction.reply({ content: 'Salon invalide.', ephemeral: true }).catch(() => {});
return true;
}
await interaction.deferUpdate().catch(() => {});
try {
const { guild } = await this.#collectZoneChannels(zoneRow);
const channel = await guild.channels.fetch(channelId).catch(() => null);
if (!channel) throw new Error('channel not found');

const { coreRoles, customRoles } = await this.#collectZoneRoles(zoneRow);
const validRoleIds = new Set();
if (coreRoles.member) validRoleIds.add(coreRoles.member.id);
for (const entry of customRoles) validRoleIds.add(entry.role.id);

const selectedIds = new Set((interaction.values || []).filter((value) => validRoleIds.has(value)));
if (zoneRow.role_owner_id) selectedIds.add(zoneRow.role_owner_id);

const botMember = guild.members.me || (await guild.members.fetch(this.client.user.id).catch(() => null));
const botRole = botMember?.roles?.highest || null;

const overwrites = this.#buildChannelPermissionOverwrites(guild, zoneRow, channel, selectedIds, botRole);
await channel.permissionOverwrites.set(overwrites);

const { embed, components } = await this.renderChannels(zoneRow, channelId);
await interaction.message.edit({ embeds: [embed], components }).catch(() => {});
} catch (err) {
await interaction.followUp?.({ content: 'Impossible de mettre à jour les permissions du salon.', ephemeral: true }).catch(() => {});
}
return true;
}

await interaction.deferUpdate().catch(() => {});
return true;
}

async handleButton(interaction) {
const id = interaction.customId || '';
if (!id.startsWith('panel:')) return false;
const parts = id.split(':');
const zoneId = Number(parts[3] || parts.at(-1));
if (!zoneId) {
await interaction.reply({ content: 'Zone invalide.', ephemeral: true }).catch(() => {});
return true;
}
const zoneRow = await this.#getZone(zoneId);
if (!zoneRow) {
await interaction.reply({ content: 'Zone introuvable.', ephemeral: true }).catch(() => {});
return true;
}
if (interaction.user.id !== String(zoneRow.owner_user_id)) {
await interaction.reply({ content: 'Tu ne peux pas gérer cette zone.', ephemeral: true }).catch(() => {});
return true;
}

if (parts[1] === 'member') {
const memberId = parts[4];
if (parts[2] === 'assign') {
const { embed, components } = await this.renderMembers(zoneRow, memberId, { assignMode: true });
await interaction.update({ embeds: [embed], components }).catch(() => {});
return true;
}

if (parts[2] === 'view') {
const targetId = parts[4] || null;
const { embed, components } = await this.renderMembers(zoneRow, targetId);
await interaction.update({ embeds: [embed], components }).catch(() => {});
return true;
}

if (parts[2] === 'kick') {
if (!memberId) {
await interaction.reply({ content: 'Membre invalide.', ephemeral: true }).catch(() => {});
return true;
}
if (memberId === String(zoneRow.owner_user_id)) {
await interaction.reply({ content: 'Impossible d’exclure le propriétaire de la zone.', ephemeral: true }).catch(() => {});
return true;
}
const confirmRow = new ActionRowBuilder().addComponents(
new ButtonBuilder()
.setCustomId(`panel:member:kick-confirm:${zoneRow.id}:${memberId}`)
.setLabel('Confirmer')
.setStyle(ButtonStyle.Danger),
new ButtonBuilder()
.setCustomId(`panel:member:kick-cancel:${zoneRow.id}:${memberId}`)
.setLabel('Annuler')
.setStyle(ButtonStyle.Secondary)
);
await interaction.reply({ content: `Confirmer l’exclusion de <@${memberId}> ?`, components: [confirmRow], ephemeral: true }).catch(() => {});
return true;
}

if (parts[2] === 'kick-confirm') {
if (!memberId) {
await interaction.update({ content: 'Membre invalide.', components: [] }).catch(() => {});
return true;
}
if (memberId === String(zoneRow.owner_user_id)) {
await interaction.update({ content: 'Impossible d’exclure le propriétaire.', components: [] }).catch(() => {});
return true;
}
await interaction.deferUpdate().catch(() => {});
try {
const { guild } = await this.#collectZoneMembers(zoneRow);
const member = await guild.members.fetch(memberId).catch(() => null);
if (member) {
const roleIds = new Set();
if (zoneRow.role_member_id) roleIds.add(zoneRow.role_member_id);
if (zoneRow.role_owner_id) roleIds.add(zoneRow.role_owner_id);
const { customRoles } = await this.#collectZoneRoles(zoneRow);
for (const entry of customRoles) roleIds.add(entry.role.id);
await member.roles.remove([...roleIds]).catch(() => {});
}
await this.db.query('DELETE FROM zone_members WHERE zone_id = ? AND user_id = ?', [zoneRow.id, memberId]).catch(() => {});
await interaction.editReply({ content: `✅ <@${memberId}> a été exclu de la zone.`, components: [] }).catch(() => {});
await this.refresh(zoneRow.id, ['members']);
} catch (err) {
await interaction.editReply({ content: 'Impossible d’exclure ce membre.', components: [] }).catch(() => {});
}
return true;
}

if (parts[2] === 'kick-cancel') {
await interaction.update({ content: 'Exclusion annulée.', components: [] }).catch(() => {});
return true;
}
}

if (parts[1] === 'role') {
const roleId = parts[4];
if (parts[2] === 'add') {
const modal = new ModalBuilder()
.setCustomId(`panel:role:create:${zoneRow.id}`)
.setTitle('Créer un rôle');
const nameInput = new TextInputBuilder()
.setCustomId('roleName')
.setLabel('Nom du rôle')
.setStyle(TextInputStyle.Short)
.setRequired(true)
.setMaxLength(100);
const colorInput = new TextInputBuilder()
.setCustomId('roleColor')
.setLabel('Couleur (#RRGGBB) — optionnel')
.setStyle(TextInputStyle.Short)
.setRequired(false)
.setMaxLength(7);
modal.addComponents(
new ActionRowBuilder().addComponents(nameInput),
new ActionRowBuilder().addComponents(colorInput)
);
await interaction.showModal(modal);
return true;
}

if (parts[2] === 'modify') {
if (!roleId) {
await interaction.reply({ content: 'Rôle invalide.', ephemeral: true }).catch(() => {});
return true;
}
const { customRoles } = await this.#collectZoneRoles(zoneRow);
const entry = customRoles.find((item) => item.role.id === roleId);
if (!entry) {
await interaction.reply({ content: 'Ce rôle est introuvable ou protégé.', ephemeral: true }).catch(() => {});
return true;
}
const modal = new ModalBuilder()
.setCustomId(`panel:role:update:${zoneRow.id}:${roleId}`)
.setTitle('Modifier le rôle');
const nameInput = new TextInputBuilder()
.setCustomId('roleName')
.setLabel('Nom du rôle')
.setStyle(TextInputStyle.Short)
.setRequired(true)
.setValue(entry.role.name.slice(0, 100));
const colorValue = entry.row?.color || (entry.role.hexColor && entry.role.hexColor !== '#000000' ? entry.role.hexColor : '');
const colorInput = new TextInputBuilder()
.setCustomId('roleColor')
.setLabel('Couleur (#RRGGBB) — optionnel')
.setStyle(TextInputStyle.Short)
.setRequired(false);
if (colorValue) colorInput.setValue(colorValue);
modal.addComponents(
new ActionRowBuilder().addComponents(nameInput),
new ActionRowBuilder().addComponents(colorInput)
);
await interaction.showModal(modal);
return true;
}

if (parts[2] === 'delete') {
if (!roleId) {
await interaction.reply({ content: 'Rôle invalide.', ephemeral: true }).catch(() => {});
return true;
}
const { embed, components } = await this.renderRoles(zoneRow, roleId, { confirmDeleteFor: roleId });
await interaction.update({ embeds: [embed], components }).catch(() => {});
return true;
}

if (parts[2] === 'delete-cancel') {
const selectedId = roleId || null;
const { embed, components } = await this.renderRoles(zoneRow, selectedId);
await interaction.update({ embeds: [embed], components }).catch(() => {});
return true;
}

if (parts[2] === 'delete-confirm') {
if (!roleId) {
await interaction.deferUpdate().catch(() => {});
return true;
}
await interaction.deferUpdate().catch(() => {});
try {
const { guild } = await this.#collectZoneRoles(zoneRow);
const role = await guild.roles.fetch(roleId).catch(() => null);
if (role) await role.delete(`Suppression via panneau de zone #${zoneRow.id}`).catch(() => {});
await this.db.query('DELETE FROM zone_roles WHERE zone_id = ? AND role_id = ?', [zoneRow.id, roleId]);
await this.refresh(zoneRow.id, ['roles']);
await interaction.followUp({ content: 'Rôle supprimé.', ephemeral: true }).catch(() => {});
} catch (err) {
await interaction.followUp({ content: 'Impossible de supprimer ce rôle.', ephemeral: true }).catch(() => {});
}
return true;
}
}

if (parts[1] === 'ch') {
const channelId = parts[4];
if (parts[2] === 'add') {
const modal = new ModalBuilder()
.setCustomId(`panel:ch:create:${zoneRow.id}`)
.setTitle('Créer un salon');
const nameInput = new TextInputBuilder()
.setCustomId('channelName')
.setLabel('Nom du salon')
.setStyle(TextInputStyle.Short)
.setRequired(true)
.setMaxLength(100);
const typeInput = new TextInputBuilder()
.setCustomId('channelType')
.setLabel('Type (text ou voice)')
.setStyle(TextInputStyle.Short)
.setRequired(true)
.setMaxLength(10);
const descriptionInput = new TextInputBuilder()
.setCustomId('channelDescription')
.setLabel('Description (optionnel)')
.setStyle(TextInputStyle.Paragraph)
.setRequired(false)
.setMaxLength(1024);
modal.addComponents(
new ActionRowBuilder().addComponents(nameInput),
new ActionRowBuilder().addComponents(typeInput),
new ActionRowBuilder().addComponents(descriptionInput)
);
await interaction.showModal(modal);
return true;
}

const { channels } = await this.#collectZoneChannels(zoneRow);
const entry = channelId ? channels.find((item) => item.channel.id === channelId) : null;

if (parts[2] === 'modify') {
if (!entry) {
await interaction.reply({ content: 'Salon introuvable.', ephemeral: true }).catch(() => {});
return true;
}
if (entry.isProtected) {
await interaction.reply({ content: 'Ce salon est protégé et ne peut pas être modifié.', ephemeral: true }).catch(() => {});
return true;
}
const channel = entry.channel;
const modal = new ModalBuilder()
.setCustomId(`panel:ch:update:${zoneRow.id}:${channel.id}`)
.setTitle('Modifier le salon');
const nameInput = new TextInputBuilder()
.setCustomId('channelName')
.setLabel('Nom du salon')
.setStyle(TextInputStyle.Short)
.setRequired(true)
.setValue(channel.name.slice(0, 100));
const descriptionInput = new TextInputBuilder()
.setCustomId('channelDescription')
.setLabel('Description (optionnel)')
.setStyle(TextInputStyle.Paragraph)
.setRequired(false);
if (channel.type === ChannelType.GuildText && channel.topic) {
descriptionInput.setValue(channel.topic.slice(0, 1024));
}
modal.addComponents(
new ActionRowBuilder().addComponents(nameInput),
new ActionRowBuilder().addComponents(descriptionInput)
);
await interaction.showModal(modal);
return true;
}

if (parts[2] === 'delete') {
if (!entry) {
await interaction.reply({ content: 'Salon introuvable.', ephemeral: true }).catch(() => {});
return true;
}
if (entry.isProtected) {
await interaction.reply({ content: 'Ce salon est protégé et ne peut pas être supprimé.', ephemeral: true }).catch(() => {});
return true;
}
const { embed, components } = await this.renderChannels(zoneRow, entry.channel.id, { confirmDeleteFor: entry.channel.id });
await interaction.update({ embeds: [embed], components }).catch(() => {});
return true;
}

if (parts[2] === 'delete-cancel') {
const selectedId = entry?.channel.id || null;
const { embed, components } = await this.renderChannels(zoneRow, selectedId);
await interaction.update({ embeds: [embed], components }).catch(() => {});
return true;
}

if (parts[2] === 'delete-confirm') {
if (!entry) {
await interaction.deferUpdate().catch(() => {});
return true;
}
if (entry.isProtected) {
await interaction.deferUpdate().catch(() => {});
await interaction.followUp({ content: 'Ce salon est protégé et ne peut pas être supprimé.', ephemeral: true }).catch(() => {});
return true;
}
await interaction.deferUpdate().catch(() => {});
try {
const guild = await this.client.guilds.fetch(zoneRow.guild_id);
const channel = await guild.channels.fetch(entry.channel.id).catch(() => null);
if (channel) await channel.delete(`Suppression via panneau de zone #${zoneRow.id}`).catch(() => {});
await this.refresh(zoneRow.id, ['channels']);
await interaction.followUp({ content: 'Salon supprimé.', ephemeral: true }).catch(() => {});
} catch (err) {
await interaction.followUp({ content: 'Impossible de supprimer ce salon.', ephemeral: true }).catch(() => {});
}
return true;
}
}

await interaction.deferUpdate().catch(() => {});
return true;
}

async handleModal(interaction) {
const id = interaction.customId || '';
if (!id.startsWith('panel:')) return false;
const parts = id.split(':');
const zoneId = Number(parts[3] || parts.at(-1));
if (!zoneId) {
await interaction.reply({ content: 'Zone invalide.', ephemeral: true }).catch(() => {});
return true;
}
const zoneRow = await this.#getZone(zoneId);
if (!zoneRow) {
await interaction.reply({ content: 'Zone introuvable.', ephemeral: true }).catch(() => {});
return true;
}
if (interaction.user.id !== String(zoneRow.owner_user_id)) {
await interaction.reply({ content: 'Tu ne peux pas gérer cette zone.', ephemeral: true }).catch(() => {});
return true;
}

if (parts[1] === 'role' && parts[2] === 'create') {
const nameRaw = (interaction.fields.getTextInputValue('roleName') || '').trim();
const colorRaw = (interaction.fields.getTextInputValue('roleColor') || '').trim();
if (!nameRaw.length) {
await interaction.reply({ content: 'Le nom du rôle est requis.', ephemeral: true }).catch(() => {});
return true;
}
const color = colorRaw ? this.#normalizeColor(colorRaw) : null;
if (colorRaw && !color) {
await interaction.reply({ content: 'Couleur invalide. Utilise le format #RRGGBB.', ephemeral: true }).catch(() => {});
return true;
}
await interaction.deferReply({ ephemeral: true }).catch(() => {});
try {
const { guild, customRoles } = await this.#collectZoneRoles(zoneRow);
if (customRoles.length >= 10) {
await interaction.editReply({ content: 'Limite de rôles personnalisés atteinte (10).' }).catch(() => {});
return true;
}
const safeName = nameRaw.slice(0, 100);
const role = await guild.roles.create({
name: safeName,
color: color || undefined,
mentionable: false,
reason: `Création via panneau de zone #${zoneRow.id}`
});
await this.db.query(
'INSERT INTO zone_roles (zone_id, role_id, name, color) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), color = VALUES(color)',
[zoneRow.id, role.id, safeName.slice(0, 64), color || null]
);
await interaction.editReply({ content: `✅ Rôle <@&${role.id}> créé.` }).catch(() => {});
await this.refresh(zoneRow.id, ['roles']);
} catch (err) {
await interaction.editReply({ content: 'Impossible de créer ce rôle pour le moment.' }).catch(() => {});
}
return true;
}

if (parts[1] === 'role' && parts[2] === 'update') {
const roleId = parts[4];
const nameRaw = (interaction.fields.getTextInputValue('roleName') || '').trim();
const colorRaw = (interaction.fields.getTextInputValue('roleColor') || '').trim();
if (!roleId || !nameRaw.length) {
await interaction.reply({ content: 'Rôle invalide.', ephemeral: true }).catch(() => {});
return true;
}
const normalizedColor = colorRaw ? this.#normalizeColor(colorRaw) : null;
if (colorRaw && !normalizedColor) {
await interaction.reply({ content: 'Couleur invalide. Utilise le format #RRGGBB.', ephemeral: true }).catch(() => {});
return true;
}
await interaction.deferReply({ ephemeral: true }).catch(() => {});
try {
const { guild } = await this.#collectZoneRoles(zoneRow);
const role = await guild.roles.fetch(roleId).catch(() => null);
if (!role) {
await interaction.editReply({ content: 'Rôle introuvable.' }).catch(() => {});
return true;
}
const safeName = nameRaw.slice(0, 100);
const payload = { name: safeName };
if (colorRaw === '') {
payload.color = null;
} else if (normalizedColor) {
payload.color = normalizedColor;
}
await role.edit(payload).catch(() => {});
await this.db.query(
'INSERT INTO zone_roles (zone_id, role_id, name, color) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), color = VALUES(color)',
[zoneRow.id, role.id, safeName.slice(0, 64), colorRaw === '' ? null : normalizedColor]
);
await interaction.editReply({ content: '✅ Rôle mis à jour.' }).catch(() => {});
await this.refresh(zoneRow.id, ['roles']);
} catch (err) {
await interaction.editReply({ content: 'Impossible de modifier ce rôle.' }).catch(() => {});
}
return true;
}

if (parts[1] === 'ch' && parts[2] === 'create') {
const nameRaw = (interaction.fields.getTextInputValue('channelName') || '').trim();
const typeRaw = (interaction.fields.getTextInputValue('channelType') || '').trim();
const description = (interaction.fields.getTextInputValue('channelDescription') || '').trim();
if (!nameRaw.length) {
await interaction.reply({ content: 'Le nom du salon est requis.', ephemeral: true }).catch(() => {});
return true;
}
const channelType = this.#parseChannelType(typeRaw);
if (!channelType) {
await interaction.reply({ content: 'Type de salon invalide. Utilise `text` ou `voice`.', ephemeral: true }).catch(() => {});
return true;
}
await interaction.deferReply({ ephemeral: true }).catch(() => {});
try {
const guild = await this.client.guilds.fetch(zoneRow.guild_id);
const channel = await guild.channels.create({
name: nameRaw.slice(0, 100),
type: channelType,
parent: zoneRow.category_id,
topic: channelType === ChannelType.GuildText ? (description || undefined) : undefined,
reason: `Création via panneau de zone #${zoneRow.id}`
});
const botMember = guild.members.me || (await guild.members.fetch(this.client.user.id).catch(() => null));
const botRole = botMember?.roles?.highest || null;
const allowed = new Set();
if (zoneRow.role_owner_id) allowed.add(zoneRow.role_owner_id);
if (zoneRow.role_member_id) allowed.add(zoneRow.role_member_id);
const overwrites = this.#buildChannelPermissionOverwrites(guild, zoneRow, channel, allowed, botRole);
await channel.permissionOverwrites.set(overwrites);
await interaction.editReply({ content: `✅ Salon ${channelType === ChannelType.GuildVoice ? 'vocal' : 'textuel'} créé.` }).catch(() => {});
await this.refresh(zoneRow.id, ['channels']);
} catch (err) {
await interaction.editReply({ content: 'Impossible de créer ce salon.' }).catch(() => {});
}
return true;
}

if (parts[1] === 'ch' && parts[2] === 'update') {
const channelId = parts[4];
const nameRaw = (interaction.fields.getTextInputValue('channelName') || '').trim();
const description = (interaction.fields.getTextInputValue('channelDescription') || '').trim();
if (!channelId || !nameRaw.length) {
await interaction.reply({ content: 'Salon invalide.', ephemeral: true }).catch(() => {});
return true;
}
await interaction.deferReply({ ephemeral: true }).catch(() => {});
try {
const guild = await this.client.guilds.fetch(zoneRow.guild_id);
const channel = await guild.channels.fetch(channelId).catch(() => null);
if (!channel) {
await interaction.editReply({ content: 'Salon introuvable.' }).catch(() => {});
return true;
}
const { channels } = await this.#collectZoneChannels(zoneRow);
const entry = channels.find((item) => item.channel.id === channelId);
if (entry?.isProtected) {
await interaction.editReply({ content: 'Ce salon est protégé et ne peut pas être modifié.' }).catch(() => {});
return true;
}
const safeName = nameRaw.slice(0, 100);
if (channel.type === ChannelType.GuildVoice) {
await channel.setName(safeName).catch(() => {});
} else {
await channel.edit({ name: safeName, topic: description || null }).catch(() => {});
}
await interaction.editReply({ content: '✅ Salon mis à jour.' }).catch(() => {});
await this.refresh(zoneRow.id, ['channels']);
} catch (err) {
await interaction.editReply({ content: 'Impossible de modifier ce salon.' }).catch(() => {});
}
return true;
}

await interaction.reply({ content: 'Action invalide.', ephemeral: true }).catch(() => {});
return true;
}

async #ensureSchema() {
		if (this.#schemaReady) return;
		await this.db.query(`CREATE TABLE IF NOT EXISTS panel_messages (
			zone_id INT NOT NULL PRIMARY KEY,
			members_msg_id VARCHAR(32) NULL,
			roles_msg_id VARCHAR(32) NULL,
			channels_msg_id VARCHAR(32) NULL,
			policy_msg_id VARCHAR(32) NULL,
			updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		await this.db.query(`CREATE TABLE IF NOT EXISTS zone_roles (
			id INT AUTO_INCREMENT PRIMARY KEY,
			zone_id INT NOT NULL,
			role_id VARCHAR(20) NOT NULL,
			name VARCHAR(64) NOT NULL,
			color VARCHAR(7) NULL,
			UNIQUE KEY uq_zone_role (zone_id, role_id),
			INDEX ix_zone (zone_id)
		) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
		this.#schemaReady = true;
	}
}

module.exports = { PanelService };
