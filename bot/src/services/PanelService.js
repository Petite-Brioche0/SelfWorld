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
        PermissionFlagsBits,
        MessageFlags
} = require('discord.js');

class PanelService {
	#schemaReady = false;
        constructor(client, db, logger = null, services = null) {
                this.client = client;
                this.db = db;
                this.logger = logger;
                this.services = services || null;
                this.activity = services?.activity || null;
        }

        setServices(services) {
                this.services = services || null;
                this.activity = services?.activity || null;
        }

	async renderInitialPanel({ zone }) {
		if (!zone?.id) return;
		try {
			await this.refresh(zone.id, ['members', 'roles', 'channels', 'policy', 'refresh']);
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
			roles: { column: 'roles_msg_id', render: () => this.renderRoles(zoneRow) },
			channels: { column: 'channels_msg_id', render: () => this.renderChannels(zoneRow) },
			policy: { column: 'policy_msg_id', render: () => this.renderPolicy(zoneRow) },
                        refresh: { column: 'refresh_msg_id', render: () => this.renderRefresh(zoneRow) }
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

                try {
                        await this.removeReceptionWelcome(zoneRow);
                } catch (err) {
                        this.logger?.warn({ err, zoneId: zoneRow.id }, 'Failed to remove reception welcome message');
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

                if (!sections.length) sections = ['members', 'roles', 'channels', 'policy', 'refresh'];

                const map = {
			members: { column: 'members_msg_id', render: () => this.renderMembers(zoneRow) },
			roles: { column: 'roles_msg_id', render: () => this.renderRoles(zoneRow) },
			channels: { column: 'channels_msg_id', render: () => this.renderChannels(zoneRow) },
			policy: { column: 'policy_msg_id', render: () => this.renderPolicy(zoneRow) },
                        refresh: { column: 'refresh_msg_id', render: () => this.renderRefresh(zoneRow) }
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

                try {
                        await this.removeReceptionWelcome(zoneRow);
                } catch (err) {
                        this.logger?.warn({ err, zoneId: zoneRow.id }, 'Failed to remove reception welcome message');
                }
        }

        async removeReceptionWelcome(zoneRow) {
                if (!zoneRow?.id) return;
                await this.#ensureSchema();

                const existingId = await this.#getPanelMessageId(zoneRow.id, 'reception_welcome');
                if (!existingId) return;

                const recep = await this.#fetchChannel(zoneRow.text_reception_id);
                if (!recep?.isTextBased?.()) {
                        await this.#setPanelMessageId(zoneRow.id, 'reception_welcome', null);
                        return;
                }

                const msg = await recep.messages.fetch(existingId).catch(() => null);
                if (!msg) {
                        await this.#setPanelMessageId(zoneRow.id, 'reception_welcome', null);
                        return;
                }

                const deleted = await msg.delete().then(() => true).catch(() => false);
                if (deleted) {
                        await this.#setPanelMessageId(zoneRow.id, 'reception_welcome', null);
                }
        }

        // ===== Renderers

        async renderRefresh(zoneRow) {
                let resolvedColor = 0x5865f2;
                try {
                        resolvedColor = await this.#resolveZoneColor(zoneRow);
                } catch { /* ignored */ }

                const embed = new EmbedBuilder()
                        .setTitle('🛠️ Panneau à jour ?')
                        .setDescription(
                                'Il arrive que le panneau mette quelques minutes à refléter les changements. Si quelque chose paraît bloqué, utilise le bouton ci-dessous pour forcer une actualisation immédiate.'
                        )
                        .setColor(resolvedColor || 0x5865f2)

                const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                                .setCustomId(`panel:refresh:${zoneRow.id}`)
                                .setLabel('🔄 Actualiser maintenant')
                                .setStyle(ButtonStyle.Secondary)
                );

                return { embed, components: [row] };
        }

        async renderMembers(zoneRow, selectedMemberId = null, options = {}) {
                const { confirmKickFor = null } = options;
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
                        const { coreRoles, customRoles } = await this.#collectZoneRoles(zoneRow);
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
                                                .setLabel('Confirmer l’exclusion')
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
				: 'Les salons vocaux n’ont pas de description.';

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

       async renderPolicy(zoneRow) {
               const policy = zoneRow.policy || 'closed';
               const helperMap = {
                       open: 'Accès immédiat pour toute personne qui clique sur « Rejoindre ».',
                       ask: 'Les nouvelles personnes doivent passer par une demande ou un code.',
                       closed: 'Aucun accès public — uniquement les membres actuels.'
               };

               let resolvedColor = 0x5865f2;
               try {
                       resolvedColor = await this.#resolveZoneColor(zoneRow);
               } catch { /* ignored */ }

               const embed = new EmbedBuilder()
                       .setColor(resolvedColor)
                       .setTitle('🔐 Politique d’entrée')
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
                       'Aucune description configurée pour l’instant.';
               embed.addFields(
                       { name: 'Titre public', value: profileTitle.slice(0, 100), inline: false },
                       { name: 'Description', value: profileDesc.slice(0, 200), inline: false }
               );

               const tags = Array.isArray(zoneRow.profile_tags)
                       ? zoneRow.profile_tags
                       : this.#parseTags(zoneRow.profile_tags);
               if (tags?.length) {
                       embed.addFields({ name: 'Tags', value: tags.map((tag) => `#${tag}`).join(' · '), inline: false });
               }

               if (policy === 'open') {
                       const activityService = this.#getActivityService();
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

	// ===== helpers

        #getActivityService() {
                if (this.activity) return this.activity;
                const fromServices = this.services?.activity || this.client?.context?.services?.activity || null;
                if (fromServices) {
                        this.activity = fromServices;
                }
                return this.activity;
        }

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
                        [zoneRow.text_panel_id, zoneRow.text_reception_id, zoneRow.text_anon_id].filter(Boolean)
                );

                const fetched = await guild.channels.fetch();
                const channels = [...fetched.values()]
                        .filter((channel) => channel?.parentId === category.id)
                        .map((channel) => ({ channel, isProtected: protectedIds.has(channel.id) }))
                        .sort((a, b) => a.channel.rawPosition - b.channel.rawPosition);

                return { guild, channels };
        }

        async #addMemberRoleRecord(zoneRow, memberId, roleId) {
                if (!zoneRow?.id || !memberId || !roleId) return;
                await this.db.query(
                        'INSERT INTO zone_member_roles (zone_id, role_id, user_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)',
                        [zoneRow.id, roleId, memberId]
                );
        }

        async #removeMemberRoleRecord(zoneRow, memberId, roleId) {
                if (!zoneRow?.id || !memberId || !roleId) return;
                await this.db.query('DELETE FROM zone_member_roles WHERE zone_id = ? AND role_id = ? AND user_id = ?', [
                        zoneRow.id,
                        roleId,
                        memberId
                ]);
        }

        async #replaceMemberRoleRecords(zoneRow, memberId, desiredRoleIds) {
                if (!zoneRow?.id || !memberId) return;
                const desired = new Set((desiredRoleIds ? [...desiredRoleIds] : []).filter(Boolean));
                const [rows] = await this.db.query(
                        'SELECT role_id FROM zone_member_roles WHERE zone_id = ? AND user_id = ?',
                        [zoneRow.id, memberId]
                );
                const current = new Set(Array.isArray(rows) ? rows.map((row) => row.role_id) : []);

                const toAdd = [...desired].filter((roleId) => !current.has(roleId));
                const toRemove = [...current].filter((roleId) => !desired.has(roleId));

                for (const roleId of toAdd) {
                        await this.#addMemberRoleRecord(zoneRow, memberId, roleId);
                }

                if (toRemove.length) {
                        const placeholders = toRemove.map(() => '?').join(',');
                        await this.db.query(
                                `DELETE FROM zone_member_roles WHERE zone_id = ? AND user_id = ? AND role_id IN (${placeholders})`,
                                [zoneRow.id, memberId, ...toRemove]
                        );
                }
        }

        async #syncZoneMembership(zoneRow, memberId, { hasOwnerRole = false, hasMemberRole = false } = {}) {
                if (!zoneRow?.id || !memberId) return;

                if (hasOwnerRole) {
                        await this.db.query(
                                'INSERT INTO zone_members (zone_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
                                [zoneRow.id, memberId, 'owner']
                        );
                        return;
                }

                if (hasMemberRole) {
                        await this.db.query(
                                'INSERT INTO zone_members (zone_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
                                [zoneRow.id, memberId, 'member']
                        );
                        return;
                }

                await this.db.query('DELETE FROM zone_members WHERE zone_id = ? AND user_id = ?', [zoneRow.id, memberId]);
        }

        async #removeAllMemberRoleRecords(zoneRow, memberId) {
                if (!zoneRow?.id || !memberId) return;
                await this.db.query('DELETE FROM zone_member_roles WHERE zone_id = ? AND user_id = ?', [zoneRow.id, memberId]);
        }

        async #removeRoleAssignments(zoneRow, roleId) {
                if (!zoneRow?.id || !roleId) return;
                await this.db.query('DELETE FROM zone_member_roles WHERE zone_id = ? AND role_id = ?', [zoneRow.id, roleId]);
        }

        #buildChannelPermissionOverwrites(guild, zoneRow, channel, allowedRoleIds, botRole = null, { denyRoleIds = [] } = {}) {
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

		const ownerAllow = channel.type === ChannelType.GuildVoice ? voiceAllow : textAllow;
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

                const denyBase = [PermissionFlagsBits.ViewChannel];
                if (channel.type === ChannelType.GuildVoice) {
                        denyBase.push(PermissionFlagsBits.Connect);
                }

                const denySet = new Set(denyRoleIds || []);
                denySet.delete(zoneRow.role_owner_id);
                for (const roleId of denySet) {
                        if (!roleId) continue;
                        if (unique.has(roleId)) continue;
                        overwrites.push({ id: roleId, deny: denyBase });
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

        #parseTags(raw) {
                if (!raw) return [];
                if (Array.isArray(raw)) {
                        return raw
                                .map((entry) => String(entry || '').trim().toLowerCase())
                                .filter((entry) => entry.length)
                                .slice(0, 10);
                }
                if (typeof raw === 'string') {
                        try {
                                const parsed = JSON.parse(raw);
                                if (Array.isArray(parsed)) {
                                        return this.#parseTags(parsed);
                                }
                        } catch { /* ignored */ }
                        return raw
                                .split(',')
                                .map((entry) => entry.trim().toLowerCase())
                                .filter((entry) => entry.length)
                                .slice(0, 10);
                }
                return [];
        }

        #parseChannelType(raw) {
                if (!raw) return null;
                const input = raw.trim().toLowerCase();
                const simplified = input
                        .normalize('NFD')
                        .replace(/\p{Diacritic}/gu, '')
                        .replace(/\s+/g, '');
                if (['text', 'texte', 'txt', 'textuel', 'salontexte', 'salontextuel'].includes(simplified)) {
                        return ChannelType.GuildText;
                }
                if (['voice', 'vocal', 'voc', 'voicechannel', 'salonvocal', 'audio'].includes(simplified)) {
                        return ChannelType.GuildVoice;
                }
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
		} catch { /* ignored */ }
		return 0x5865f2;
	}

	async handleSelectMenu(interaction) {
		const id = interaction.customId || '';
		if (!id.startsWith('panel:')) return false;

		const parts = id.split(':');
		const zoneId = Number(parts[3] || parts.at(-1));
		if (!zoneId) {
			await interaction.reply({ content: '❌ **Zone invalide**\n\nCette zone n\'existe pas ou son identifiant est incorrect.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

		const zoneRow = await this.#getZone(zoneId);
		if (!zoneRow) {
			await interaction.reply({ content: '❌ **Zone introuvable**\n\nCette zone n\'existe plus ou a été supprimée.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

		if (interaction.user.id !== String(zoneRow.owner_user_id)) {
			await interaction.reply({ content: '🔒 **Accès refusé**\n\nTu ne possèdes pas les permissions nécessaires pour gérer cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

                if (parts[1] === 'member' && parts[2] === 'select') {
                        const selectedId = interaction.values?.[0];
                        const { embed, components } = await this.renderMembers(zoneRow, selectedId);
                        await interaction.update({ embeds: [embed], components }).catch(() => { });
                        return true;
                }

                if (parts[1] === 'member' && parts[2] === 'assignRole') {
                        const memberId = parts[4];
                        if (!memberId) {
                                await interaction.reply({ content: '❌ **Membre invalide**\n\nCe membre est introuvable ou n\'est plus dans ce serveur.', flags: MessageFlags.Ephemeral }).catch(() => { });
                                return true;
                        }
                        const values = interaction.values || [];
                        await interaction.deferUpdate().catch(() => { });
                        try {
                                const { guild, members } = await this.#collectZoneMembers(zoneRow);
                                const member = members.find((m) => m.id === memberId) || (await guild.members.fetch(memberId).catch(() => null));
                                if (!member) throw new Error('member not found');

                                const { coreRoles, customRoles } = await this.#collectZoneRoles(zoneRow);
                                const assignableIds = new Set(customRoles.map((entry) => entry.role.id));

                                const desired = new Set(values.filter((v) => assignableIds.has(v)));

                                const current = new Set(
                                        (member.roles?.cache ? [...member.roles.cache.keys()] : []).filter((id) => assignableIds.has(id))
                                );

                                const toAdd = [...desired].filter((id) => !current.has(id));
                                const toRemove = [...current].filter((id) => !desired.has(id));

                                if (toAdd.length) {
                                        await member.roles.add(toAdd).catch(() => { });
                                }
                                if (toRemove.length) {
                                        await member.roles.remove(toRemove).catch(() => { });
                                }

                                const refreshed = await guild.members.fetch(memberId).catch(() => null);
                                const snapshot = refreshed || member;
                                const updatedRoleIds = new Set(
                                        snapshot.roles?.cache
                                                ? [...snapshot.roles.cache.keys()].filter((id) => assignableIds.has(id))
                                                : []
                                );
                                const hasOwnerRole = coreRoles.owner
                                        ? snapshot.roles?.cache?.has?.(coreRoles.owner.id) || false
                                        : false;
                                const hasMemberRole = coreRoles.member
                                        ? snapshot.roles?.cache?.has?.(coreRoles.member.id) || false
                                        : false;

                                await this.#replaceMemberRoleRecords(zoneRow, memberId, updatedRoleIds);
                                await this.#syncZoneMembership(zoneRow, memberId, { hasOwnerRole, hasMemberRole });

                                const { embed, components } = await this.renderMembers(zoneRow, memberId);
                                await interaction.editReply({ embeds: [embed], components }).catch(() => { });
                        } catch (_err) {
                                await interaction.followUp?.({ content: '❌ **Erreur de mise à jour**\n\nImpossible de mettre à jour les rôles pour le moment. Réessaye dans quelques instants.', flags: MessageFlags.Ephemeral }).catch(() => { });
                        }
                        return true;
                }

		if (parts[1] === 'role' && parts[2] === 'select') {
			const selectedRoleId = interaction.values?.[0] || null;
			const { embed, components } = await this.renderRoles(zoneRow, selectedRoleId);
			await interaction.update({ embeds: [embed], components }).catch(() => { });
			return true;
		}

		if (parts[1] === 'role' && parts[2] === 'members') {
			const roleId = parts[4];
			if (!roleId) {
				await interaction.reply({ content: '❌ **Rôle invalide**\n\nCe rôle est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
				return true;
			}
			await interaction.deferUpdate().catch(() => { });
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

                                const addedSuccessfully = [];
                                for (const memberId of toAdd) {
                                        const member = zoneMemberMap.get(memberId);
                                        if (!member) continue;
                                        try {
                                                await member.roles.add(role);
                                                addedSuccessfully.push(memberId);
                                        } catch { /* ignored */ }
                                }

                                const removedSuccessfully = [];
                                for (const memberId of toRemove) {
                                        const member = zoneMemberMap.get(memberId) || (await guild.members.fetch(memberId).catch(() => null));
                                        if (!member) continue;
                                        try {
                                                await member.roles.remove(role);
                                                removedSuccessfully.push(memberId);
                                        } catch { /* ignored */ }
                                }

                                for (const memberId of addedSuccessfully) {
                                        await this.#addMemberRoleRecord(zoneRow, memberId, role.id);
                                }

                                for (const memberId of removedSuccessfully) {
                                        await this.#removeMemberRoleRecord(zoneRow, memberId, role.id);
                                }

				const { embed, components } = await this.renderRoles(zoneRow, roleId);
				await interaction.message.edit({ embeds: [embed], components }).catch(() => { });
			} catch (_err) {
				await interaction.followUp?.({ content: '❌ **Erreur de mise à jour**\n\nImpossible de mettre à jour les membres du rôle. Vérifie que le rôle existe toujours.', flags: MessageFlags.Ephemeral }).catch(() => { });
			}
			return true;
		}

		if (parts[1] === 'ch' && parts[2] === 'select') {
			const channelId = interaction.values?.[0] || null;
			const { embed, components } = await this.renderChannels(zoneRow, channelId);
			await interaction.update({ embeds: [embed], components }).catch(() => { });
			return true;
		}

		if (parts[1] === 'ch' && parts[2] === 'roles') {
			const channelId = parts[4];
			if (!channelId) {
				await interaction.reply({ content: '❌ **Salon invalide**\n\nCe salon est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
				return true;
			}
			await interaction.deferUpdate().catch(() => { });
			try {
				const { guild } = await this.#collectZoneChannels(zoneRow);
				const channel = await guild.channels.fetch(channelId).catch(() => null);
				if (!channel) throw new Error('channel not found');

                                const { coreRoles, customRoles } = await this.#collectZoneRoles(zoneRow);
                                const validRoleIds = new Set();
                                const denyRoleIds = new Set();
                                if (coreRoles.member) {
                                        validRoleIds.add(coreRoles.member.id);
                                        denyRoleIds.add(coreRoles.member.id);
                                } else if (zoneRow.role_member_id) {
                                        denyRoleIds.add(zoneRow.role_member_id);
                                }
                                for (const entry of customRoles) {
                                        validRoleIds.add(entry.role.id);
                                        denyRoleIds.add(entry.role.id);
                                }

                                const selectedIds = new Set((interaction.values || []).filter((value) => validRoleIds.has(value)));
                                if (zoneRow.role_owner_id) selectedIds.add(zoneRow.role_owner_id);

                                const botMember = guild.members.me || (await guild.members.fetch(this.client.user.id).catch(() => null));
                                const botRole = botMember?.roles?.highest || null;

                                const overwrites = this.#buildChannelPermissionOverwrites(guild, zoneRow, channel, selectedIds, botRole, {
                                        denyRoleIds: [...denyRoleIds]
                                });
				await channel.permissionOverwrites.set(overwrites);

				const { embed, components } = await this.renderChannels(zoneRow, channelId);
				await interaction.message.edit({ embeds: [embed], components }).catch(() => { });
			} catch (_err) {
				await interaction.followUp?.({ content: '❌ **Erreur de mise à jour**\n\nImpossible de mettre à jour les permissions du salon. Vérifie qu\'il existe toujours.', flags: MessageFlags.Ephemeral }).catch(() => { });
			}
			return true;
		}

		await interaction.deferUpdate().catch(() => { });
		return true;
	}

	async handleButton(interaction) {
		const id = interaction.customId || '';
		if (!id.startsWith('panel:')) return false;
		const parts = id.split(':');
		const zoneId = Number(parts[3] || parts.at(-1));
		if (!zoneId) {
			await interaction.reply({ content: '❌ **Zone invalide**\n\nCette zone n\'existe pas ou son identifiant est incorrect.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const zoneRow = await this.#getZone(zoneId);
		if (!zoneRow) {
			await interaction.reply({ content: '❌ **Zone introuvable**\n\nCette zone n\'existe plus ou a été supprimée.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		if (interaction.user.id !== String(zoneRow.owner_user_id)) {
			await interaction.reply({ content: '🔒 **Accès refusé**\n\nTu ne possèdes pas les permissions nécessaires pour gérer cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

                if (parts[1] === 'refresh') {
                        try {
                                await interaction.deferUpdate().catch((err) => {
                                        this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to defer panel refresh');
                                });
                                await this.refresh(zoneRow.id, ['members', 'roles', 'channels', 'policy', 'refresh']);
                                if (!interaction.deferred && !interaction.replied) {
                                        await interaction
                                                .reply({ content: '✅ **Panneau actualisé**\n\nLe panneau de gestion a été mis à jour avec les dernières informations.', flags: MessageFlags.Ephemeral })
                                                .catch((err) => {
                                                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                                        this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send panel refresh confirmation');
                                                });
                                } else {
                                        await interaction
                                                .followUp({ content: '✅ **Panneau actualisé**\n\nLe panneau de gestion a été mis à jour avec les dernières informations.', flags: MessageFlags.Ephemeral })
                                                .catch((err) => {
                                                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                                        this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send panel refresh confirmation');
                                                });
                                }
                        } catch (err) {
                                this.logger?.warn({ err, zoneId: zoneRow.id }, 'Failed to refresh panel via button');
                                if (!interaction.deferred && !interaction.replied) {
                                        await interaction
                                                .reply({
                                                        content: '❌ **Erreur d\'actualisation**\n\nImpossible de rafraîchir le panneau pour le moment. Réessaye dans quelques instants.',
                                                        flags: MessageFlags.Ephemeral
                                                })
                                                .catch((err) => {
                                                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                                        this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send panel refresh error');
                                                });
                                } else {
                                        await interaction
                                                .followUp({
                                                        content: '❌ **Erreur d\'actualisation**\n\nImpossible de rafraîchir le panneau pour le moment. Réessaye dans quelques instants.',
                                                        flags: MessageFlags.Ephemeral
                                                })
                                                .catch((err) => {
                                                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                                        this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send panel refresh error');
                                                });
                                }
                        }
                        return true;
                }

                if (parts[1] === 'member') {
                        const memberId = parts[4];
                        if (parts[2] === 'kick') {
                                if (!memberId) {
                                        await interaction.reply({ content: '❌ **Membre invalide**\n\nCe membre est introuvable ou n\'est plus dans ce serveur.', flags: MessageFlags.Ephemeral }).catch(() => { });
                                        return true;
                                }
                                if (memberId === String(zoneRow.owner_user_id)) {
                                        await interaction.reply({ content: '🔒 **Action interdite**\n\nLe propriétaire de la zone ne peut pas être exclu.', flags: MessageFlags.Ephemeral }).catch(() => { });
                                        return true;
                                }
                                const { embed, components } = await this.renderMembers(zoneRow, memberId, { confirmKickFor: memberId });
                                await interaction.update({ embeds: [embed], components }).catch(() => { });
                                return true;
                        }

                        if (parts[2] === 'kick-confirm') {
                                if (!memberId) {
                                        await interaction.reply({ content: '❌ **Membre invalide**\n\nCe membre est introuvable ou n\'est plus dans ce serveur.', flags: MessageFlags.Ephemeral }).catch(() => { });
                                        return true;
                                }
                                if (memberId === String(zoneRow.owner_user_id)) {
                                        await interaction.reply({ content: '🔒 **Action interdite**\n\nLe propriétaire ne peut pas être exclu de sa propre zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
                                        return true;
                                }
                                await interaction.deferUpdate().catch(() => { });
                                try {
                                        const { guild } = await this.#collectZoneMembers(zoneRow);
                                        const member = await guild.members.fetch(memberId).catch(() => null);
                                        if (member) {
                                                const roleIds = new Set();
                                                if (zoneRow.role_member_id) roleIds.add(zoneRow.role_member_id);
                                                if (zoneRow.role_owner_id) roleIds.add(zoneRow.role_owner_id);
                                                const { customRoles } = await this.#collectZoneRoles(zoneRow);
                                                for (const entry of customRoles) roleIds.add(entry.role.id);
                                                await member.roles.remove([...roleIds]).catch(() => { });
                                        }
                                        await this.#removeAllMemberRoleRecords(zoneRow, memberId).catch(() => { });
                                        await this.db.query('DELETE FROM zone_members WHERE zone_id = ? AND user_id = ?', [zoneRow.id, memberId]).catch(() => { });
                                        const { embed, components } = await this.renderMembers(zoneRow);
                                        await interaction.editReply({ embeds: [embed], components }).catch(() => { });
                                } catch (_err) {
                                        await interaction.followUp?.({ content: '❌ **Exclusion impossible**\n\nCe membre ne peut pas être exclu pour le moment. Vérifie qu\'il est toujours dans la zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
                                        const { embed, components } = await this.renderMembers(zoneRow, memberId, { confirmKickFor: memberId });
                                        await interaction.editReply({ embeds: [embed], components }).catch(() => { });
                                }
                                return true;
                        }

                        if (parts[2] === 'kick-cancel') {
                                const { embed, components } = await this.renderMembers(zoneRow, memberId);
                                await interaction.update({ embeds: [embed], components }).catch(() => { });
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
					await interaction.reply({ content: '❌ **Rôle invalide**\n\nCe rôle est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
					return true;
				}
				const { customRoles } = await this.#collectZoneRoles(zoneRow);
				const entry = customRoles.find((item) => item.role.id === roleId);
				if (!entry) {
					await interaction.reply({ content: '🔒 **Rôle protégé**\n\nCe rôle est introuvable ou ne peut pas être modifié car il est protégé par le système.', flags: MessageFlags.Ephemeral }).catch(() => { });
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
					await interaction.reply({ content: '❌ **Rôle invalide**\n\nCe rôle est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
					return true;
				}
				const { embed, components } = await this.renderRoles(zoneRow, roleId, { confirmDeleteFor: roleId });
				await interaction.update({ embeds: [embed], components }).catch(() => { });
				return true;
			}

			if (parts[2] === 'delete-cancel') {
				const selectedId = roleId || null;
				const { embed, components } = await this.renderRoles(zoneRow, selectedId);
				await interaction.update({ embeds: [embed], components }).catch(() => { });
				return true;
			}

			if (parts[2] === 'delete-confirm') {
				if (!roleId) {
					await interaction.deferUpdate().catch(() => { });
					return true;
				}
                                await interaction.deferUpdate().catch(() => { });
                                try {
                                        const { guild } = await this.#collectZoneRoles(zoneRow);
                                        const role = await guild.roles.fetch(roleId).catch(() => null);
                                        if (role) await role.delete(`Suppression via panneau de zone #${zoneRow.id}`).catch(() => { });
                                        await this.#removeRoleAssignments(zoneRow, roleId).catch(() => { });
                                        await this.db.query('DELETE FROM zone_roles WHERE zone_id = ? AND role_id = ?', [zoneRow.id, roleId]);
                                        await this.refresh(zoneRow.id, ['roles']);
                                        await interaction.followUp({ content: '✅ **Rôle supprimé**\n\nLe rôle a été supprimé avec succès de cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
                                } catch (_err) {
                                        await interaction.followUp({ content: '❌ **Suppression impossible**\n\nCe rôle ne peut pas être supprimé pour le moment. Vérifie qu\'il existe toujours.', flags: MessageFlags.Ephemeral }).catch(() => { });
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
					.setLabel('Type (texte ou vocal)')
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
					await interaction.reply({ content: '❌ **Salon introuvable**\n\nCe salon n\'existe plus ou a été supprimé de cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
					return true;
				}
				if (entry.isProtected) {
					await interaction.reply({ content: '🔒 **Salon protégé**\n\nCe salon est protégé par le système et ne peut pas être modifié.', flags: MessageFlags.Ephemeral }).catch(() => { });
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
					await interaction.reply({ content: '❌ **Salon introuvable**\n\nCe salon n\'existe plus ou a été supprimé de cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
					return true;
				}
				if (entry.isProtected) {
					await interaction.reply({ content: '🔒 **Salon protégé**\n\nCe salon est protégé par le système et ne peut pas être supprimé.', flags: MessageFlags.Ephemeral }).catch(() => { });
					return true;
				}
				const { embed, components } = await this.renderChannels(zoneRow, entry.channel.id, { confirmDeleteFor: entry.channel.id });
				await interaction.update({ embeds: [embed], components }).catch(() => { });
				return true;
			}

			if (parts[2] === 'delete-cancel') {
				const selectedId = entry?.channel.id || null;
				const { embed, components } = await this.renderChannels(zoneRow, selectedId);
				await interaction.update({ embeds: [embed], components }).catch(() => { });
				return true;
			}

			if (parts[2] === 'delete-confirm') {
				if (!entry) {
					await interaction.deferUpdate().catch(() => { });
					return true;
				}
				if (entry.isProtected) {
					await interaction.deferUpdate().catch(() => { });
					await interaction.followUp({ content: '🔒 **Salon protégé**\n\nCe salon est protégé par le système et ne peut pas être supprimé.', flags: MessageFlags.Ephemeral }).catch(() => { });
					return true;
				}
				await interaction.deferUpdate().catch(() => { });
				try {
					const guild = await this.client.guilds.fetch(zoneRow.guild_id);
					const channel = await guild.channels.fetch(entry.channel.id).catch(() => null);
					if (channel) await channel.delete(`Suppression via panneau de zone #${zoneRow.id}`).catch(() => { });
					await this.refresh(zoneRow.id, ['channels']);
					await interaction.followUp({ content: '✅ **Salon supprimé**\n\nLe salon a été supprimé avec succès de cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
				} catch (_err) {
					await interaction.followUp({ content: '❌ **Suppression impossible**\n\nCe salon ne peut pas être supprimé pour le moment. Vérifie qu\'il existe toujours.', flags: MessageFlags.Ephemeral }).catch(() => { });
				}
				return true;
			}
		}

		await interaction.deferUpdate().catch(() => { });
		return true;
	}

	async handleModal(interaction) {
		const id = interaction.customId || '';
		if (!id.startsWith('panel:')) return false;
		const parts = id.split(':');
		const zoneId = Number(parts[3] || parts.at(-1));
		if (!zoneId) {
			await interaction.reply({ content: '❌ **Zone invalide**\n\nCette zone n\'existe pas ou son identifiant est incorrect.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		const zoneRow = await this.#getZone(zoneId);
		if (!zoneRow) {
			await interaction.reply({ content: '❌ **Zone introuvable**\n\nCette zone n\'existe plus ou a été supprimée.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}
		if (interaction.user.id !== String(zoneRow.owner_user_id)) {
			await interaction.reply({ content: '🔒 **Accès refusé**\n\nTu ne possèdes pas les permissions nécessaires pour gérer cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
			return true;
		}

		if (parts[1] === 'role' && parts[2] === 'create') {
			const nameRaw = (interaction.fields.getTextInputValue('roleName') || '').trim();
			const colorRaw = (interaction.fields.getTextInputValue('roleColor') || '').trim();
			if (!nameRaw.length) {
				await interaction.reply({ content: '⚠️ **Nom requis**\n\nTu dois fournir un nom pour créer ce rôle.', flags: MessageFlags.Ephemeral }).catch(() => { });
				return true;
			}
			const color = colorRaw ? this.#normalizeColor(colorRaw) : null;
			if (colorRaw && !color) {
				await interaction.reply({ content: '❌ **Couleur invalide**\n\nUtilise le format hexadécimal : `#RRGGBB` (ex: `#5865F2` pour bleu Discord).', flags: MessageFlags.Ephemeral }).catch(() => { });
				return true;
			}
			await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
			try {
				const { guild, customRoles } = await this.#collectZoneRoles(zoneRow);
				if (customRoles.length >= 10) {
					await interaction.editReply({ content: '⚠️ **Limite atteinte**\n\nTu as déjà créé le maximum de rôles personnalisés autorisés (10) pour cette zone.' }).catch(() => { });
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
				await interaction.editReply({ content: `✅ **Rôle créé**\n\nLe rôle <@&${role.id}> a été créé avec succès dans cette zone.` }).catch(() => { });
				await this.refresh(zoneRow.id, ['roles']);
			} catch (_err) {
				await interaction.editReply({ content: '❌ **Création impossible**\n\nImpossible de créer ce rôle pour le moment. Réessaye dans quelques instants.' }).catch(() => { });
			}
			return true;
		}

		if (parts[1] === 'role' && parts[2] === 'update') {
			const roleId = parts[4];
			const nameRaw = (interaction.fields.getTextInputValue('roleName') || '').trim();
			const colorRaw = (interaction.fields.getTextInputValue('roleColor') || '').trim();
			if (!roleId || !nameRaw.length) {
				await interaction.reply({ content: '❌ **Rôle invalide**\n\nCe rôle est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
				return true;
			}
			const normalizedColor = colorRaw ? this.#normalizeColor(colorRaw) : null;
			if (colorRaw && !normalizedColor) {
				await interaction.reply({ content: '❌ **Couleur invalide**\n\nUtilise le format hexadécimal : `#RRGGBB` (ex: `#5865F2` pour bleu Discord).', flags: MessageFlags.Ephemeral }).catch(() => { });
				return true;
			}
			await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
			try {
				const { guild } = await this.#collectZoneRoles(zoneRow);
				const role = await guild.roles.fetch(roleId).catch(() => null);
				if (!role) {
					await interaction.editReply({ content: '❌ **Rôle introuvable**\n\nCe rôle n\'existe plus ou a été supprimé de cette zone.' }).catch(() => { });
					return true;
				}
				const safeName = nameRaw.slice(0, 100);
				const payload = { name: safeName };
				if (colorRaw === '') {
					payload.color = null;
				} else if (normalizedColor) {
					payload.color = normalizedColor;
				}
				await role.edit(payload).catch(() => { });
				await this.db.query(
					'INSERT INTO zone_roles (zone_id, role_id, name, color) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), color = VALUES(color)',
					[zoneRow.id, role.id, safeName.slice(0, 64), colorRaw === '' ? null : normalizedColor]
				);
				await interaction.editReply({ content: '✅ **Rôle mis à jour**\n\nLes modifications du rôle ont été appliquées avec succès.' }).catch(() => { });
				await this.refresh(zoneRow.id, ['roles']);
			} catch (_err) {
				await interaction.editReply({ content: '❌ **Modification impossible**\n\nImpossible de modifier ce rôle. Vérifie qu\'il existe toujours et réessaye.' }).catch(() => { });
			}
			return true;
		}

		if (parts[1] === 'ch' && parts[2] === 'create') {
			const nameRaw = (interaction.fields.getTextInputValue('channelName') || '').trim();
			const typeRaw = (interaction.fields.getTextInputValue('channelType') || '').trim();
			const description = (interaction.fields.getTextInputValue('channelDescription') || '').trim();
			if (!nameRaw.length) {
				await interaction.reply({ content: '⚠️ **Nom requis**\n\nTu dois fournir un nom pour créer ce salon.', flags: MessageFlags.Ephemeral }).catch(() => { });
				return true;
			}
                        const channelType = this.#parseChannelType(typeRaw);
                        if (channelType === null) {
                                await interaction.reply({ content: '❌ **Type invalide**\n\nUtilise `texte` pour un salon textuel ou `vocal` pour un salon vocal.', flags: MessageFlags.Ephemeral }).catch(() => { });
                                return true;
                        }
			await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
			try {
                                const { guild, customRoles, coreRoles } = await this.#collectZoneRoles(zoneRow);
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
                                if (coreRoles.member) {
                                        allowed.add(coreRoles.member.id);
                                } else if (zoneRow.role_member_id) {
                                        allowed.add(zoneRow.role_member_id);
                                }
                                const denyRoleIds = new Set();
                                if (coreRoles.member) {
                                        denyRoleIds.add(coreRoles.member.id);
                                } else if (zoneRow.role_member_id) {
                                        denyRoleIds.add(zoneRow.role_member_id);
                                }
                                for (const entry of customRoles) denyRoleIds.add(entry.role.id);
                                const overwrites = this.#buildChannelPermissionOverwrites(guild, zoneRow, channel, allowed, botRole, {
                                        denyRoleIds: [...denyRoleIds]
                                });
				await channel.permissionOverwrites.set(overwrites);
				await interaction.editReply({ content: `✅ **Salon créé**\n\nLe salon ${channelType === ChannelType.GuildVoice ? 'vocal' : 'textuel'} a été créé avec succès dans cette zone.` }).catch(() => { });
				await this.refresh(zoneRow.id, ['channels']);
			} catch (_err) {
				await interaction.editReply({ content: '❌ **Création impossible**\n\nImpossible de créer ce salon pour le moment. Réessaye dans quelques instants.' }).catch(() => { });
			}
			return true;
		}

		if (parts[1] === 'ch' && parts[2] === 'update') {
			const channelId = parts[4];
			const nameRaw = (interaction.fields.getTextInputValue('channelName') || '').trim();
			const description = (interaction.fields.getTextInputValue('channelDescription') || '').trim();
			if (!channelId || !nameRaw.length) {
				await interaction.reply({ content: '❌ **Salon invalide**\n\nCe salon est introuvable ou n\'existe plus dans cette zone.', flags: MessageFlags.Ephemeral }).catch(() => { });
				return true;
			}
			await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => { });
			try {
				const guild = await this.client.guilds.fetch(zoneRow.guild_id);
				const channel = await guild.channels.fetch(channelId).catch(() => null);
				if (!channel) {
					await interaction.editReply({ content: '❌ **Salon introuvable**\n\nCe salon n\'existe plus ou a été supprimé de cette zone.' }).catch(() => { });
					return true;
				}
				const { channels } = await this.#collectZoneChannels(zoneRow);
				const entry = channels.find((item) => item.channel.id === channelId);
				if (entry?.isProtected) {
					await interaction.editReply({ content: '🔒 **Salon protégé**\n\nCe salon est protégé par le système et ne peut pas être modifié.' }).catch(() => { });
					return true;
				}
				const safeName = nameRaw.slice(0, 100);
				if (channel.type === ChannelType.GuildVoice) {
					await channel.setName(safeName).catch(() => { });
				} else {
					await channel.edit({ name: safeName, topic: description || null }).catch(() => { });
				}
				await interaction.editReply({ content: '✅ **Salon mis à jour**\n\nLes modifications du salon ont été appliquées avec succès.' }).catch(() => { });
				await this.refresh(zoneRow.id, ['channels']);
			} catch (_err) {
				await interaction.editReply({ content: '❌ **Modification impossible**\n\nImpossible de modifier ce salon. Vérifie qu\'il existe toujours et réessaye.' }).catch(() => { });
			}
			return true;
		}

		await interaction.reply({ content: '❌ **Action invalide**\n\nCette action n\'est pas reconnue ou n\'est plus disponible.', flags: MessageFlags.Ephemeral }).catch(() => { });
		return true;
	}

        async #columnExists(table, column) {
                const [rows] = await this.db.query(
                        `SELECT COUNT(*) AS n
                         FROM information_schema.COLUMNS
                         WHERE TABLE_SCHEMA = DATABASE()
                           AND TABLE_NAME = ?
                           AND COLUMN_NAME = ?`,
                        [table, column]
                );
                return Number(rows?.[0]?.n || 0) > 0;
        }

        async #ensureSchema() {
                if (this.#schemaReady) return;
                await this.db.query(`CREATE TABLE IF NOT EXISTS panel_messages (
                        zone_id BIGINT UNSIGNED NOT NULL PRIMARY KEY,
                        refresh_msg_id VARCHAR(32) NULL,
                        members_msg_id VARCHAR(32) NULL,
                        roles_msg_id VARCHAR(32) NULL,
                        channels_msg_id VARCHAR(32) NULL,
                        policy_msg_id VARCHAR(32) NULL,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                        code_anchor_channel_id VARCHAR(32) NULL,
                        code_anchor_message_id VARCHAR(32) NULL,
                        FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
                if (!(await this.#columnExists('panel_messages', 'refresh_msg_id'))) {
                        await this.db
                                .query('ALTER TABLE `panel_messages` ADD COLUMN refresh_msg_id VARCHAR(32) NULL AFTER zone_id')
                                .catch(() => {
                                        // Expected failure if column already exists - intentionally silent
                                });
                }
                await this.db.query(`CREATE TABLE IF NOT EXISTS panel_message_registry (
                        zone_id BIGINT UNSIGNED NOT NULL,
                        kind VARCHAR(32) NOT NULL,
                        message_id VARCHAR(32) NOT NULL,
                        PRIMARY KEY(zone_id, kind),
                        FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
                await this.db.query(`CREATE TABLE IF NOT EXISTS zone_roles (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        zone_id BIGINT UNSIGNED NOT NULL,
                        role_id VARCHAR(32) NOT NULL,
                        name VARCHAR(64) NOT NULL,
                        color VARCHAR(7) NULL,
                        UNIQUE KEY uq_zone_role (zone_id, role_id),
                        INDEX ix_zone (zone_id),
                        FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
                await this.db.query(`CREATE TABLE IF NOT EXISTS zone_member_roles (
                        zone_id BIGINT UNSIGNED NOT NULL,
                        role_id VARCHAR(32) NOT NULL,
                        user_id VARCHAR(32) NOT NULL,
                        PRIMARY KEY(zone_id, role_id, user_id),
                        FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);
                this.#schemaReady = true;
        }

        async #getPanelMessageId(zoneId, kind) {
                if (!zoneId || !kind) return null;
                const [rows] = await this.db.query(
                        'SELECT message_id FROM panel_message_registry WHERE zone_id = ? AND kind = ? LIMIT 1',
                        [zoneId, kind]
                );
                return rows?.[0]?.message_id || null;
        }

        async #setPanelMessageId(zoneId, kind, messageId) {
                if (!zoneId || !kind) return;
                if (!messageId) {
                        await this.db
                                .query('DELETE FROM panel_message_registry WHERE zone_id = ? AND kind = ?', [zoneId, kind])
                                .catch((err) => {
                                        this.logger?.warn({ err, zoneId, kind }, 'Failed to delete panel message registry entry');
                                });
                        return;
                }
                await this.db.query(
                        'INSERT INTO panel_message_registry (zone_id, kind, message_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE message_id = VALUES(message_id)',
                        [zoneId, kind, messageId]
                );
        }
}

module.exports = { PanelService };
