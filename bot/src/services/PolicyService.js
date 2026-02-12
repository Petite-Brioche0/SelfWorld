const crypto = require('node:crypto');
const {
        ActionRowBuilder,
        ButtonBuilder,
        ButtonStyle,
        ChannelType,
        EmbedBuilder,
        MessageFlags,
        ModalBuilder,
        PermissionFlagsBits,
        TextInputBuilder,
        TextInputStyle
} = require('discord.js');
const { applyZoneOverwrites } = require('../utils/permissions');
const { validateZoneName, validateZoneDescription, sanitizeName } = require('../utils/validation');

const POLICY_VALUES = new Set(['open', 'ask', 'closed']);
const ASK_MODES = new Set(['request', 'invite', 'both']);
const APPROVER_MODES = new Set(['owner', 'members']);

class PolicyService {
        #schemaReady = false;

        constructor(client, db, logger = null, panelService = null) {
                this.client = client;
                this.db = db;
                this.logger = logger;
                this.panelService = panelService;
                this.services = null;
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

        setPanelService(panelService) {
                this.panelService = panelService;
                if (this.panelService?.setServices && this.services) {
                        this.panelService.setServices(this.services);
                }
        }

        setServices(services) {
                this.services = services;
                if (this.panelService?.setServices) {
                        this.panelService.setServices(services);
                }
        }

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

                await this.#ensureSchema();
                const zone = await this.#getZone(zoneId);
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

                if (!(await this.#canModerateRequests(zone, interaction.user.id, actorMember))) {
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
                        "SELECT * FROM zone_join_requests WHERE zone_id = ? AND user_id = ? AND status = 'pending' ORDER BY id DES"
                                + 'C LIMIT 1',
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
                        // Unknown interaction (10062) is expected and safe to ignore
                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                        this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer update');
                }

                const approved = action === 'approve';
                let statusUpdate = 'declined';
                if (approved) statusUpdate = 'accepted';

                try {
                        const [result] = await this.db.query(
                                'UPDATE zone_join_requests SET status = ?, decided_by = ?, decided_at = NOW() WHERE id = ? AND st'
                                        + "atus = 'pending'",
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
                                await this.#grantZoneMembership(zone, targetUserId);
                                await this.#dmUser(targetUserId, {
                                        content: `✅ Ta demande pour **${zone.name}** a été acceptée !`
                                });
                        } else {
                                await this.#dmUser(targetUserId, {
                                        content: `❌ Ta demande pour **${zone.name}** a été refusée.`
                                });
                        }

                        await this.#refreshPanel(zone.id);
                        await this.#disableInteractionRow(interaction.message);

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
        }

        async handleZoneRequestModal(interaction) {
                await this.#ensureSchema();

                const payload = this.#extractCreationRequestPayload(interaction);
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

                        const conflict = await this.#zoneNameExists(guildId, nameResult.value);
                        if (conflict) {
                                errors.push('Nom indisponible : une zone existe déjà avec ce nom.');
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
                        const request = this.#hydrateCreationRequest({
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

                        const delivered = await this.#deliverCreationRequest(request);
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

                return true;
        }

        async handleCreationRequestButton(interaction) {
                await this.#ensureSchema();

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

                const request = await this.#getCreationRequest(requestId);
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
                                                .setValue(this.#policyLabel(request.policy || 'ask'))
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
                                await this.#disableCreationRequestMessage(updated, 'Refusée');
                                await this.#dmUser(request.user_id, {
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
                        await this.#createZoneFromRequest(request, {
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
        }

        async handleCreationRequestModal(interaction) {
                await this.#ensureSchema();

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

                const request = await this.#getCreationRequest(requestId);
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
                const normalizedPolicy = this.#normalizePolicyInput(policyInput);

                const issues = [...nameResult.errors, ...descResult.errors];
                if (!normalizedPolicy) {
                        issues.push('Politique invalide : choisis fermé, sur demande ou ouvert.');
                }

                if (nameResult.value !== request.name) {
                        const conflict = await this.#zoneNameExists(request.guild_id, nameResult.value);
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
                        await this.#createZoneFromRequest(request, {
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
        }

        async handlePolicySelect(interaction) {
                const [_, __, action, zoneIdRaw] = interaction.customId.split(':');
                if (action !== 'set') return false;
                const zoneId = Number(zoneIdRaw);
                if (!zoneId || !interaction.values?.length) {
                        await interaction.reply({ content: 'Sélection invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid policy selection reply');
                        });
                        return true;
                }

                const zone = await this.#getZone(zoneId);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send policy zone-not-found reply');
                        });
                        return true;
                }

                if (!(await this.#isZoneOwner(zone, interaction.user.id))) {
                        await interaction.reply({ content: "Seul l'owner peut modifier la politique.", flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send policy owner-only reply');
                        });
                        return true;
                }

                const nextPolicy = interaction.values[0];
                try {
                        await interaction.deferUpdate();
                } catch (err) {
                        // Unknown interaction (10062) is expected and safe to ignore
                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                        this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer update');
                }

                try {
                        await this.setPolicy(zoneId, nextPolicy, interaction.user.id);
                        await this.#syncPolicyPanelMessage(interaction, zoneId);
                        await this.#refreshPanel(zoneId);
                        await interaction.followUp({
                                content: `Politique mise à jour sur **${nextPolicy}**.`,
                                flags: MessageFlags.Ephemeral
                        });
                } catch (err) {
                        this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to set policy from panel');
                        await interaction.followUp({
                                content: `Impossible de mettre à jour la politique : ${err.message || err}`,
                                flags: MessageFlags.Ephemeral
                        }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send policy update error');
                        });
                }

                return true;
        }

        async handleProfileButton(interaction) {
                const parts = interaction.customId.split(':');
                const zoneId = Number(parts.at(-1));
                if (!zoneId) {
                        await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid profile zone reply');
                        });
                        return true;
                }
                const zone = await this.#getZone(zoneId);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile zone-not-found reply');
                        });
                        return true;
                }
                if (!(await this.#isZoneOwner(zone, interaction.user.id))) {
                        await interaction.reply({ content: "Seul l'owner peut modifier le profil.", flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile owner-only reply');
                        });
                        return true;
                }

                const modal = this.#buildProfileModal(zone);
                await interaction.showModal(modal);
                return true;
        }

        async handleProfileModal(interaction) {
                const parts = interaction.customId.split(':');
                const zoneId = Number(parts.at(-1));
                if (!zoneId) {
                        await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid profile modal zone reply');
                        });
                        return true;
                }

                const zone = await this.#getZone(zoneId);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile modal zone-not-found reply');
                        });
                        return true;
                }

                if (!(await this.#isZoneOwner(zone, interaction.user.id))) {
                        await interaction.reply({ content: "Seul l'owner peut modifier le profil.", flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile modal owner-only reply');
                        });
                        return true;
                }

                const payload = {
                        profile_title: interaction.fields.getTextInputValue('policyProfileTitle')?.trim(),
                        profile_desc: interaction.fields.getTextInputValue('policyProfileDesc')?.trim(),
                        profile_color: interaction.fields.getTextInputValue('policyProfileColor')?.trim(),
                        profile_tags: interaction.fields.getTextInputValue('policyProfileTags')?.trim()
                };

                try {
                        await this.updateProfile(zoneId, payload, interaction.user.id);
                        await interaction.reply({
                                content: 'Profil public mis à jour ✅',
                                flags: MessageFlags.Ephemeral
                        });
                        await this.#refreshPanel(zoneId);
                } catch (err) {
                        this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to update policy profile');
                        await interaction.reply({
                                content: `Impossible de mettre à jour le profil : ${err.message || err}`,
                                flags: MessageFlags.Ephemeral
                        }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send profile update error');
                        });
                }

                return true;
        }

        async handleAskModeSelect(interaction) {
                const zoneId = Number(interaction.customId.split(':').at(-1));
                if (!zoneId) {
                        await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid ask-mode zone reply');
                        });
                        return true;
                }
                const zone = await this.#getZone(zoneId);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send ask-mode zone-not-found reply');
                        });
                        return true;
                }
                if (zone.policy !== 'ask') {
                        await interaction.reply({ content: "Cette zone n'est pas en mode demande.", flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send not-ask-mode reply');
                        });
                        return true;
                }
                if (!(await this.#isZoneOwner(zone, interaction.user.id))) {
                        await interaction.reply({ content: "Seul l'owner peut modifier ce réglage.", flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send ask-mode owner-only reply');
                        });
                        return true;
                }

                const mode = interaction.values?.[0];
                if (!mode) {
                        await interaction.reply({ content: 'Sélection invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send invalid ask-mode selection reply');
                        });
                        return true;
                }

                try {
                        await interaction.deferUpdate();
                } catch (err) {
                        // Unknown interaction (10062) is expected and safe to ignore
                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                        this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer update');
                }

                try {
                        await this.setAskMode(zoneId, mode, interaction.user.id);
                        await interaction.followUp({ content: 'Mode de demande mis à jour.', flags: MessageFlags.Ephemeral });
                        await this.#refreshPanel(zoneId);
                } catch (err) {
                        this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to set ask mode');
                        await interaction.followUp({
                                content: `Impossible de modifier le mode : ${err.message || err}`,
                                flags: MessageFlags.Ephemeral
                        }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send ask-mode update error');
                        });
                }
                return true;
        }

        async handleApproverSelect(interaction) {
                const zoneId = Number(interaction.customId.split(':').at(-1));
                if (!zoneId) {
                        await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid approver zone reply');
                        });
                        return true;
                }
                const zone = await this.#getZone(zoneId);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send approver zone-not-found reply');
                        });
                        return true;
                }
                if (zone.policy !== 'ask') {
                        await interaction.reply({ content: "Cette zone n'est pas en mode demande.", flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send approver not-ask-mode reply');
                        });
                        return true;
                }
                if (!(await this.#isZoneOwner(zone, interaction.user.id))) {
                        await interaction.reply({ content: "Seul l'owner peut modifier ce réglage.", flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send approver owner-only reply');
                        });
                        return true;
                }

                const mode = interaction.values?.[0];
                if (!mode) {
                        await interaction.reply({ content: 'Sélection invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send invalid approver selection reply');
                        });
                        return true;
                }

                try {
                        await interaction.deferUpdate();
                } catch (err) {
                        // Unknown interaction (10062) is expected and safe to ignore
                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                        this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to defer update');
                }

                try {
                        await this.setApproverMode(zoneId, mode, interaction.user.id);
                        await interaction.followUp({ content: 'Décideur mis à jour.', flags: MessageFlags.Ephemeral });
                        await this.#refreshPanel(zoneId);
                } catch (err) {
                        this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to set approver mode');
                        await interaction.followUp({
                                content: `Impossible de modifier le décideur : ${err.message || err}`,
                                flags: MessageFlags.Ephemeral
                        }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send approver update error');
                        });
                }
                return true;
        }

        async handleGenerateCode(interaction) {
                const zoneId = Number(interaction.customId.split(':').at(-1));
                if (!zoneId) {
                        await interaction.reply({ content: 'Zone invalide.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, customId: interaction.customId }, 'Failed to send invalid generate-code zone reply');
                        });
                        return true;
                }

                await this.#ensureSchema();
                const zone = await this.#getZone(zoneId);
                if (!zone) {
                        await interaction.reply({ content: 'Zone introuvable.', flags: MessageFlags.Ephemeral }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send generate-code zone-not-found reply');
                        });
                        return true;
                }

                if (zone.policy !== 'ask' || !['invite', 'both'].includes(zone.ask_join_mode || 'invite')) {
                        await interaction.reply({
                                content: 'Cette zone ne permet pas de générer des codes actuellement.',
                                flags: MessageFlags.Ephemeral
                        }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send code-not-allowed reply');
                        });
                        return true;
                }

                const guild = interaction.guild ?? (await this.client.guilds.fetch(zone.guild_id).catch(() => null));
                const actorMember =
                        interaction.member ?? (guild ? await guild.members.fetch(interaction.user.id).catch(() => null) : null);

                if (!(await this.#canModerateRequests(zone, interaction.user.id, actorMember))) {
                        await interaction.reply({
                                content: 'Tu ne peux pas générer de codes pour cette zone.',
                                flags: MessageFlags.Ephemeral
                        }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send cannot-generate-code reply');
                        });
                        return true;
                }

                try {
                        const { code } = await this.createInviteCode(zone.id, interaction.user.id);

                        await interaction.reply({
                                content: `Code généré : \`${code}\` — valide 24h, usage unique.`,
                                flags: MessageFlags.Ephemeral
                        });
                } catch (err) {
                        this.logger?.warn({ err, zoneId, actorId: interaction.user.id }, 'Failed to generate invite code');
                        await interaction.reply({
                                content: `Impossible de générer un code : ${err.message || err}`,
                                flags: MessageFlags.Ephemeral
                        }).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction.user.id, zoneId }, 'Failed to send code generation error');
                        });
                }

                return true;
        }

        async setPolicy(zoneId, policy, actorId = null) {
                await this.#ensureSchema();
                if (!POLICY_VALUES.has(policy)) {
                        throw new Error('Politique inconnue.');
                }
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('Zone introuvable');

                const updates = { policy };
                if (policy === 'open') {
                        if (!zone.profile_title) updates.profile_title = zone.name || 'Zone';
                        if (!zone.profile_color) {
                                try {
                                        updates.profile_color = await this.#resolveOwnerColor(zone);
                                } catch (err) {
                                        this.logger?.debug({ err, zoneId: zone.id }, 'Failed to resolve owner color, using default');
                                        updates.profile_color = '#5865F2';
                                }
                        }
                }

                if (policy === 'ask') {
                        if (!ASK_MODES.has(zone.ask_join_mode)) updates.ask_join_mode = 'request';
                        if (!APPROVER_MODES.has(zone.ask_approver_mode)) updates.ask_approver_mode = 'owner';
                } else {
                        updates.ask_join_mode = null;
                        updates.ask_approver_mode = null;
                }

                const placeholders = [];
                const values = [];
                for (const [key, value] of Object.entries(updates)) {
                        placeholders.push(`${key} = ?`);
                        values.push(value);
                }
                values.push(zoneId);
                await this.db.query(`UPDATE zones SET ${placeholders.join(', ')} WHERE id = ?`, values);

                this.logger?.info({ zoneId, actorId, policy }, 'Zone policy updated');

                const updatedZone = await this.#getZone(zoneId);

                if (policy === 'ask') {
                        if ((updatedZone.ask_approver_mode || 'owner') === 'owner') {
                                await this.#ensureInterviewRoom(updatedZone);
                        } else {
                                await this.#cleanupInterviewRoom(updatedZone);
                        }
                        await this.#cleanupCodeAnchor(updatedZone);
                } else {
                        await this.#cleanupInterviewRoom(updatedZone);
                        await this.#cleanupCodeAnchor(updatedZone);
                }
        }

        async updateProfile(zoneId, data, actorId = null) {
                await this.#ensureSchema();
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('Zone introuvable');
                const updates = {};

                const title = (data.profile_title || '').trim();
                if (!title) throw new Error('Le titre est obligatoire.');
                updates.profile_title = title.slice(0, 100);

                const desc = (data.profile_desc || '').trim();
                updates.profile_desc = desc ? desc.slice(0, 1000) : null;

                const color = this.#normalizeColor(data.profile_color);
                if (data.profile_color && !color) {
                                throw new Error('Couleur invalide. Utilise un format #RRGGBB.');
                }
                updates.profile_color = color;

                const tags = this.#sanitizeTags(data.profile_tags);
                updates.profile_tags = tags.length ? JSON.stringify(tags) : null;

                const columns = [];
                const values = [];
                for (const [key, value] of Object.entries(updates)) {
                        columns.push(`${key} = ?`);
                        values.push(value);
                }
                values.push(zoneId);
                await this.db.query(`UPDATE zones SET ${columns.join(', ')} WHERE id = ?`, values);
                this.logger?.info({ zoneId, actorId }, 'Zone profile updated');
        }

        async setAskMode(zoneId, mode, actorId = null) {
                await this.#ensureSchema();
                if (!ASK_MODES.has(mode)) throw new Error('Mode invalide');
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('Zone introuvable');
                if (zone.policy !== 'ask') throw new Error('Politique incompatible');

                await this.db.query('UPDATE zones SET ask_join_mode = ? WHERE id = ?', [mode, zoneId]);
                this.logger?.info({ zoneId, actorId, mode }, 'Ask mode updated');

                const updatedZone = await this.#getZone(zoneId);
                await this.#cleanupCodeAnchor(updatedZone);
        }

        async setApproverMode(zoneId, mode, actorId = null) {
                await this.#ensureSchema();
                if (!APPROVER_MODES.has(mode)) throw new Error('Mode invalide');
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('Zone introuvable');
                if (zone.policy !== 'ask') throw new Error('Politique incompatible');

                await this.db.query('UPDATE zones SET ask_approver_mode = ? WHERE id = ?', [mode, zoneId]);
                this.logger?.info({ zoneId, actorId, mode }, 'Approver mode updated');

                const updatedZone = await this.#getZone(zoneId);

                if (mode === 'owner') {
                        await this.#ensureInterviewRoom(updatedZone);
                } else {
                        await this.#cleanupInterviewRoom(updatedZone);
                }

                await this.#cleanupCodeAnchor(updatedZone);
        }

        async getZone(zoneId) {
                await this.#ensureSchema();
                return this.#getZone(zoneId);
        }

        async listDiscoverableZones({ limit = 3, offset = 0 } = {}) {
                await this.#ensureSchema();
                const clampedLimit = Math.min(Math.max(1, Number(limit) || 3), 5);
                const safeOffset = Math.max(0, Number(offset) || 0);

                const [rows] = await this.db.query(
                        `SELECT * FROM zones
                        WHERE policy = 'open'
                           OR (policy = 'ask' AND ask_join_mode IN ('request','both'))
                        ORDER BY name ASC
                        LIMIT ? OFFSET ?`,
                        [clampedLimit, safeOffset]
                );

                const [countRows] = await this.db.query(
                        "SELECT COUNT(*) AS total FROM zones WHERE policy = 'open' OR (policy = 'ask' AND ask_join_mode IN ('request','both'))"
                );

                const total = countRows?.[0]?.total || 0;

                return {
                        zones: rows.map((row) => this.#hydrateZoneRow(row)),
                        total
                };
        }

        async isUserMember(zoneId, userId) {
                const [rows] = await this.db.query(
                        'SELECT 1 FROM zone_members WHERE zone_id = ? AND user_id = ? LIMIT 1',
                        [zoneId, userId]
                );
                return Boolean(rows?.length);
        }

        async createJoinRequest(zoneId, userId, options = {}) {
                await this.#ensureSchema();
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('Zone introuvable');
                if (zone.policy !== 'ask') throw new Error('Zone indisponible pour des demandes.');
                if (await this.isUserMember(zoneId, userId)) {
                        return { status: 'already-member', zone };
                }

                const note = this.#sanitizeJoinNote(options.note);

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
        }

        async postJoinRequestCard(zone, request, applicantMember = null, context = {}) {
                if (!zone?.id || !request?.id) return null;

                await this.#ensureSchema();

                const channel = await this.#resolveRequestChannel(zone, context.ensureInterview !== false);
                if (!channel) return null;

                const embed = this.#buildJoinRequestEmbed(zone, request, applicantMember, context);

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
        }

        async createInviteCode(zoneId, actorId, options = {}) {
                await this.#ensureSchema();
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('Zone introuvable');
                if (zone.policy !== 'ask' || !['invite', 'both'].includes(zone.ask_join_mode || 'invite')) {
                        throw new Error('Cette zone ne permet pas les codes d’invitation.');
                }

                const maxAttempts = 5;
                let code = null;
                for (let i = 0; i < maxAttempts; i += 1) {
                        code = this.#generateCode();
                        try {
                                await this.db.query(
                                        'INSERT INTO zone_invite_codes (zone_id, code, created_by, expires_at, max_uses, uses) VALUES (?, ?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR), 1, 0)',
                                        [zoneId, code, actorId]
                                );
                                break;
                        } catch (err) {
                                if (i === maxAttempts - 1) throw err;
                        }
                }

                if (!code) throw new Error('Impossible de générer un code.');

                this.logger?.info({ zoneId, actorId }, 'Zone invite code generated');

                return { code, zone };
        }

        async redeemInviteCode(rawCode, userId) {
                await this.#ensureSchema();
                const code = String(rawCode || '').trim().toUpperCase();
                if (!/^[A-Z0-9]{6}$/.test(code)) {
                        throw new Error('Code invalide.');
                }

                const [rows] = await this.db.query('SELECT * FROM zone_invite_codes WHERE code = ?', [code]);
                const entry = rows?.[0];
                if (!entry) throw new Error('Code inconnu ou expiré.');

                const zone = await this.#getZone(entry.zone_id);
                if (!zone) throw new Error('Zone introuvable.');

                if (zone.policy !== 'ask' || !['invite', 'both'].includes(zone.ask_join_mode || 'invite')) {
                        throw new Error('Cette zone n’accepte plus les codes.');
                }

                if (entry.expires_at && new Date(entry.expires_at) < new Date()) {
                        throw new Error('Ce code a expiré.');
                }

                if (entry.max_uses != null && entry.uses >= entry.max_uses) {
                        throw new Error('Ce code a atteint sa limite.');
                }

                if (await this.isUserMember(zone.id, userId)) {
                        return { status: 'already-member', zone };
                }

                await this.db.query('UPDATE zone_invite_codes SET uses = uses + 1 WHERE id = ?', [entry.id]);

                await this.db.query('DELETE FROM zone_invite_codes WHERE id = ?', [entry.id]).catch((err) => {
                        this.logger?.warn({ err, codeId: entry.id, zoneId: zone.id }, 'Failed to delete used invite code');
                });

                await this.#grantZoneMembership(zone, userId);

                this.logger?.info({ zoneId: zone.id, userId }, 'Invite code redeemed');

                return { status: 'joined', zone };
        }

        async grantMembership(zoneId, userId) {
                await this.#ensureSchema();
                const zone = await this.#getZone(zoneId);
                if (!zone) throw new Error('Zone introuvable');
                await this.#grantZoneMembership(zone, userId);
                return zone;
        }

        async #ensureSchema() {
                if (this.#schemaReady) return;

                await this.db.query(`CREATE TABLE IF NOT EXISTS zone_invite_codes (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        zone_id BIGINT UNSIGNED NOT NULL,
                        code VARCHAR(16) NOT NULL UNIQUE,
                        created_by VARCHAR(32) NOT NULL,
                        expires_at DATETIME NULL,
                        max_uses INT NULL,
                        uses INT NOT NULL DEFAULT 0,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        INDEX ix_zone (zone_id),
                        FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);

                await this.db.query(`CREATE TABLE IF NOT EXISTS zone_join_requests (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        zone_id BIGINT UNSIGNED NOT NULL,
                        user_id VARCHAR(32) NOT NULL,
                        status ENUM('pending','accepted','declined','expired') NOT NULL DEFAULT 'pending',
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        decided_by VARCHAR(32) NULL,
                        decided_at DATETIME NULL,
                        note TEXT NULL,
                        message_channel_id VARCHAR(32) NULL,
                        message_id VARCHAR(32) NULL,
                        INDEX ix_zone_user (zone_id, user_id),
                        FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE CASCADE
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);

                await this.db.query(`CREATE TABLE IF NOT EXISTS zone_creation_requests (
                        id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
                        guild_id VARCHAR(32) NOT NULL,
                        user_id VARCHAR(32) NOT NULL,
                        owner_user_id VARCHAR(32) NOT NULL,
                        name VARCHAR(100) NOT NULL,
                        description TEXT NULL,
                        extras TEXT NULL,
                        policy ENUM('open','ask','closed') NOT NULL DEFAULT 'ask',
                        status ENUM('pending','accepted','denied') NOT NULL DEFAULT 'pending',
                        validation_errors TEXT NULL,
                        message_channel_id VARCHAR(32) NULL,
                        message_id VARCHAR(32) NULL,
                        zone_id BIGINT UNSIGNED NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                        decided_at DATETIME NULL,
                        decided_by VARCHAR(32) NULL,
                        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                        INDEX ix_guild (guild_id),
                        INDEX ix_status (status),
                        FOREIGN KEY(zone_id) REFERENCES zones(id) ON DELETE SET NULL
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;`);

                const addColumnIfMissing = async (table, column, ddl) => {
                        const exists = await this.#columnExists(table, column);
                        if (!exists) {
                                await this.db.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
                        }
                };

                await addColumnIfMissing(
                        'zones',
                        'policy',
                        "policy ENUM('open','ask','closed') NOT NULL DEFAULT 'closed'"
                );
                await addColumnIfMissing(
                        'zones',
                        'ask_join_mode',
                        "ask_join_mode ENUM('request','invite','both') NULL"
                );
                await addColumnIfMissing(
                        'zones',
                        'ask_approver_mode',
                        "ask_approver_mode ENUM('owner','members') NULL"
                );
                await addColumnIfMissing('zones', 'profile_title', 'profile_title VARCHAR(100) NULL');
                await addColumnIfMissing('zones', 'profile_desc', 'profile_desc TEXT NULL');
                await addColumnIfMissing('zones', 'profile_tags', 'profile_tags JSON NULL');
                await addColumnIfMissing('zones', 'profile_color', 'profile_color VARCHAR(7) NULL');
                await addColumnIfMissing(
                        'zones',
                        'profile_dynamic',
                        'profile_dynamic TINYINT(1) NOT NULL DEFAULT 0'
                );

                await this.db
                        .query(
                                "UPDATE zones SET policy='ask', ask_join_mode = COALESCE(ask_join_mode, 'invite') WHERE policy = 'invite'"
                        )
                        .catch((err) => {
                                this.logger?.warn({ err }, 'Failed to migrate invite policy to ask');
                        });

                await this.db
                        .query(
                                "ALTER TABLE zones MODIFY COLUMN policy ENUM('open','ask','closed') NOT NULL DEFAULT 'closed'"
                        )
                        .catch((err) => {
                                this.logger?.warn({ err }, 'Failed to modify policy enum column');
                        });

                await addColumnIfMissing('zone_join_requests', 'note', 'note TEXT NULL');
                await addColumnIfMissing(
                        'zone_join_requests',
                        'message_channel_id',
                        'message_channel_id VARCHAR(32) NULL'
                );
                await addColumnIfMissing('zone_join_requests', 'message_id', 'message_id VARCHAR(32) NULL');

                await addColumnIfMissing(
                        'panel_messages',
                        'code_anchor_channel_id',
                        'code_anchor_channel_id VARCHAR(32) NULL'
                );
                await addColumnIfMissing(
                        'panel_messages',
                        'code_anchor_message_id',
                        'code_anchor_message_id VARCHAR(32) NULL'
                );

                await addColumnIfMissing(
                        'zone_creation_requests',
                        'owner_user_id',
                        "owner_user_id VARCHAR(32) NOT NULL DEFAULT ''"
                );
                await addColumnIfMissing('zone_creation_requests', 'extras', 'extras TEXT NULL');
                await addColumnIfMissing('zone_creation_requests', 'validation_errors', 'validation_errors TEXT NULL');
                await addColumnIfMissing('zone_creation_requests', 'message_channel_id', 'message_channel_id VARCHAR(32) NULL');
                await addColumnIfMissing('zone_creation_requests', 'message_id', 'message_id VARCHAR(32) NULL');
                await addColumnIfMissing('zone_creation_requests', 'zone_id', 'zone_id BIGINT UNSIGNED NULL');

                this.#schemaReady = true;
        }

        async #getZone(zoneId) {
                const [rows] = await this.db.query('SELECT * FROM zones WHERE id = ?', [zoneId]);
                if (!rows?.length) return null;
                return this.#hydrateZoneRow(rows[0]);
        }

        #hydrateZoneRow(row) {
                if (!row) return null;
                const zone = { ...row };
                if (zone.profile_tags) {
                        if (Array.isArray(zone.profile_tags)) {
                                zone.profile_tags = zone.profile_tags;
                        } else if (typeof zone.profile_tags === 'string') {
                                try {
                                        zone.profile_tags = JSON.parse(zone.profile_tags);
                                } catch {
                                        zone.profile_tags = null;
                                }
                        }
                }
                return zone;
        }

        #slugify(value) {
                return sanitizeName(value)
                        .toLowerCase()
                        .replace(/[^a-z0-9\-\s]/g, '')
                        .replace(/\s+/g, '-')
                        .slice(0, 32);
        }

        async #zoneNameExists(guildId, name) {
                if (!guildId || !name) return false;
                const slug = this.#slugify(name);
                const [rows] = await this.db.query('SELECT id FROM zones WHERE guild_id = ? AND slug = ? LIMIT 1', [guildId, slug]);
                return Boolean(rows?.length);
        }

        #hydrateCreationRequest(row) {
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

        #extractCreationRequestPayload(interaction) {
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
        }

        async #getCreationRequest(requestId) {
                const [rows] = await this.db.query('SELECT * FROM zone_creation_requests WHERE id = ?', [requestId]);
                if (!rows?.length) return null;
                return this.#hydrateCreationRequest(rows[0]);
        }

        async #getRequestsChannelId(guildId) {
                if (!guildId) return null;
                const [rows] = await this.db.query('SELECT requests_channel_id FROM settings WHERE guild_id = ?', [guildId]);
                const configured = rows?.[0]?.requests_channel_id;
                return configured || process.env.ZONE_REQUESTS_CHANNEL_ID || null;
        }

        #normalizePolicyInput(input) {
                const value = sanitizeName(input).toLowerCase();
                if (!value) return null;
                if (['ferme', 'fermé', 'closed', 'close'].includes(value)) return 'closed';
                if (['sur demande', 'demande', 'ask', 'request'].includes(value)) return 'ask';
                if (['ouvert', 'open'].includes(value)) return 'open';
                return null;
        }

        #policyLabel(policy) {
                switch (policy) {
                        case 'open':
                                return 'Ouvert';
                        case 'closed':
                                return 'Fermé';
                        case 'ask':
                        default:
                                return 'Sur demande';
                }
        }

        #formatValidationErrors(errors = []) {
                if (!Array.isArray(errors) || !errors.length) return null;
                return errors.map((err) => `• ${err}`).join('\n');
        }

        #buildCreationRequestComponents(requestId) {
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

        #buildCreationRequestEmbed(request) {
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
                                        value: this.#policyLabel(request.policy || 'ask'),
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

                const formattedErrors = this.#formatValidationErrors(request.validation_errors);
                if (formattedErrors) {
                        embed.addFields({ name: '⚠️ À corriger', value: formattedErrors, inline: false });
                }

                return embed;
        }

        async #deliverCreationRequest(request) {
                const components = this.#buildCreationRequestComponents(request.id);
                const embed = this.#buildCreationRequestEmbed(request);
                const ownerId =
                        this.client?.context?.config?.ownerUserId ||
                        process.env.OWNER_ID ||
                        process.env.OWNER_USER_ID;

                let message = null;

                if (request.guild_id) {
                        const channelId = await this.#getRequestsChannelId(request.guild_id);
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
        }

        async #disableCreationRequestMessage(request, statusLabel) {
                if (!request?.message_channel_id || !request?.message_id) return;
                try {
                        const channel = await this.client.channels.fetch(request.message_channel_id).catch(() => null);
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
                                                this.logger?.debug({ err }, 'Failed to clone button component for disabling');
                                        }
                                }
                                if (newRow.components.length) {
                                        components.push(newRow);
                                }
                        }

                        const embed = this.#buildCreationRequestEmbed({
                                ...request,
                                validation_errors: request.validation_errors || []
                        });
                        if (statusLabel) {
                                embed.setFooter({ text: statusLabel });
                        }

                        await message.edit({ embeds: [embed], components }).catch((err) => {
                                if (err?.code === 10008) return;
                                this.logger?.warn({ err, messageId: message?.id, requestId: request?.id }, 'Failed to edit creation request message');
                        });
                } catch (err) {
                        this.logger?.warn({ err, requestId: request?.id }, 'Failed to update creation request message');
                }
        }

        async #createZoneFromRequest(request, { actorId, name, description, policy }) {
                const guild = await this.client.guilds.fetch(request.guild_id).catch(() => null);
                if (!guild) throw new Error('Serveur introuvable');
                const zoneService = this.services?.zone;
                if (!zoneService?.createZone) throw new Error('Service de zone indisponible');

                const finalName = sanitizeName(name || request.name).slice(0, 64);
                const finalDescription = (description ?? request.description) || '';
                const finalPolicy = POLICY_VALUES.has(policy) ? policy : request.policy || 'ask';

                const result = await zoneService.createZone(guild, {
                        name: finalName,
                        ownerUserId: request.owner_user_id || request.user_id,
                        policy: finalPolicy
                });

                await this.db.query(
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
                await this.#disableCreationRequestMessage(updated, 'Acceptée');
                await this.#dmUser(request.user_id, {
                        content: `🎉 Ta zone **${finalName}** a été créée !`
                });

                return result;
        }

        async #isZoneOwner(zone, userId) {
                if (!zone) return false;
                if (String(zone.owner_user_id) === String(userId)) return true;
                if (!zone.id) return false;
                const [rows] = await this.db.query(
                        'SELECT role FROM zone_members WHERE zone_id = ? AND user_id = ? LIMIT 1',
                        [zone.id, userId]
                );
                return rows?.[0]?.role === 'owner';
        }

        async #refreshPanel(zoneId) {
                if (!this.panelService?.refresh) return;
                try {
                        await this.panelService.refresh(zoneId, ['policy']);
                } catch (err) {
                        this.logger?.warn({ err, zoneId }, 'Failed to refresh policy panel');
                }
        }

        async #syncPolicyPanelMessage(interaction, zoneId) {
                if (!interaction?.message?.id || !zoneId) return false;

                let updated = false;
                if (this.panelService?.renderPolicy && typeof interaction.message.edit === 'function') {
                        const zone = await this.#getZone(zoneId);
                        if (!zone) return false;
                        try {
                                const { embed, components } = await this.panelService.renderPolicy(zone);
                                await interaction.message.edit({ embeds: [embed], components });
                                updated = true;
                        } catch (err) {
                                this.logger?.warn({ err, zoneId }, 'Failed to update policy panel message from interaction');
                        }
                }

                try {
                        await this.db.query(
                                'INSERT INTO panel_messages (zone_id, policy_msg_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE policy_msg_id = VALUES(policy_msg_id)',
                                [zoneId, interaction.message.id]
                        );
                } catch (err) {
                        if (err?.code !== 'ER_NO_SUCH_TABLE') {
                                this.logger?.warn({ err, zoneId }, 'Failed to sync policy panel message id');
                        }
                }

                return updated;
        }

        #buildProfileModal(zone) {
                const modal = new ModalBuilder()
                        .setCustomId(`panel:policy:profile:modal:${zone.id}`)
                        .setTitle('Profil public de la zone');

                const titleInput = new TextInputBuilder()
                        .setCustomId('policyProfileTitle')
                        .setLabel('Titre public')
                        .setStyle(TextInputStyle.Short)
                        .setValue(zone.profile_title || zone.name || '')
                        .setRequired(true)
                        .setMaxLength(100);

                const descInput = new TextInputBuilder()
                        .setCustomId('policyProfileDesc')
                        .setLabel('Description (optionnel)')
                        .setStyle(TextInputStyle.Paragraph)
                        .setRequired(false)
                        .setMaxLength(1000)
                        .setValue(zone.profile_desc?.slice(0, 1000) || '');

                const colorInput = new TextInputBuilder()
                        .setCustomId('policyProfileColor')
                        .setLabel('Couleur (#RRGGBB)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setMaxLength(7)
                        .setValue(zone.profile_color || '');

                const tags = Array.isArray(zone.profile_tags) ? zone.profile_tags.join(', ') : '';
                const tagsInput = new TextInputBuilder()
                        .setCustomId('policyProfileTags')
                        .setLabel('Tags (séparés par des virgules)')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(false)
                        .setMaxLength(200)
                        .setValue(tags);

                modal.addComponents(
                        new ActionRowBuilder().addComponents(titleInput),
                        new ActionRowBuilder().addComponents(descInput),
                        new ActionRowBuilder().addComponents(colorInput),
                        new ActionRowBuilder().addComponents(tagsInput)
                );

                return modal;
        }

        #normalizeColor(value) {
                if (!value) return null;
                let hex = String(value).trim();
                if (!hex.length) return null;
                if (!hex.startsWith('#')) hex = `#${hex}`;
                if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return null;
                return hex.toUpperCase();
        }

        #sanitizeTags(raw) {
                if (!raw) return [];
                let source = raw;
                if (Array.isArray(raw)) {
                        source = raw;
                } else if (typeof raw === 'string') {
                        source = raw.split(',');
                } else {
                        return [];
                }
                return source
                        .map((entry) => String(entry || '').trim().toLowerCase())
                        .filter((entry) => entry.length)
                        .slice(0, 8);
        }

        async #resolveOwnerColor(zone) {
                if (!zone) throw new Error('Zone invalide');
                const guild = await this.client.guilds.fetch(zone.guild_id);
                if (zone.role_owner_id) {
                        const ownerRole = await guild.roles.fetch(zone.role_owner_id).catch(() => null);
                        if (ownerRole?.hexColor && ownerRole.hexColor !== '#000000') {
                                return ownerRole.hexColor.toUpperCase();
                        }
                }
                if (zone.role_member_id) {
                        const memberRole = await guild.roles.fetch(zone.role_member_id).catch(() => null);
                        if (memberRole?.hexColor && memberRole.hexColor !== '#000000') {
                                return memberRole.hexColor.toUpperCase();
                        }
                }
                return '#5865F2';
        }

        async #ensureInterviewRoom(zone) {
                try {
                        const guild = await this.client.guilds.fetch(zone.guild_id);
                        const existing = await this.#findInterviewRoom(zone);
                        if (existing) return existing;

                        const channel = await guild.channels.create({
                                name: 'cv-entretien',
                                type: ChannelType.GuildText,
                                parent: zone.category_id,
                                reason: 'Zone join requests (owner)',
                                topic: 'Salon privé pour examiner les demandes d’entrée.'
                        });

                        await this.#applyInterviewPermissions(zone, channel);

                        const panelChannel = await guild.channels.fetch(zone.text_panel_id).catch(() => null);
                        if (panelChannel?.parentId === channel.parentId) {
                                await channel.setPosition(panelChannel.position + 1).catch((err) => {
                                        this.logger?.warn({ err, channelId: channel.id, zoneId: zone.id }, 'Failed to set interview room position');
                                });
                        }

                        this.logger?.info({ zoneId: zone.id, channelId: channel.id }, 'Created cv-entretien channel');
                        return channel;
                } catch (err) {
                        this.logger?.warn({ err, zoneId: zone.id }, 'Failed to ensure cv-entretien');
                        throw err;
                }
        }

        async #cleanupInterviewRoom(zone) {
                const channel = await this.#findInterviewRoom(zone);
                if (!channel) return;
                try {
                        await channel.delete('Zone join requests mode updated');
                        this.logger?.info({ zoneId: zone.id, channelId: channel.id }, 'Deleted cv-entretien channel');
                } catch (err) {
                        this.logger?.warn({ err, zoneId: zone.id, channelId: channel.id }, 'Failed to delete cv-entretien channel');
                }
        }

        async #findInterviewRoom(zone) {
                        if (!zone?.category_id) return null;
                        try {
                                const guild = await this.client.guilds.fetch(zone.guild_id);
                                const collection = await guild.channels.fetch();
                                return (
                                        [...collection.values()].find(
                                                (channel) =>
                                                        channel?.type === ChannelType.GuildText &&
                                                        channel?.parentId === zone.category_id &&
                                                        channel?.name === 'cv-entretien'
                                        ) || null
                                );
                        } catch (err) {
                                this.logger?.warn({ err, zoneId: zone?.id }, 'Failed to find cv-entretien channel');
                                return null;
                        }
        }

        async #applyInterviewPermissions(zone, channel) {
                if (!channel) return;
                try {
                        const guild = channel.guild || (await this.client.guilds.fetch(zone.guild_id));
                        const ownerRole = zone.role_owner_id
                                ? await guild.roles.fetch(zone.role_owner_id).catch(() => null)
                                : null;
                        const memberRole = zone.role_member_id
                                ? await guild.roles.fetch(zone.role_member_id).catch(() => null)
                                : null;
                        const botMember = guild.members.me || (await guild.members.fetch(this.client.user.id).catch(() => null));
                        const botRole = botMember?.roles?.highest || null;

                        const overwrites = [
                                { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
                        ];
                        if (memberRole) {
                                overwrites.push({ id: memberRole.id, deny: [PermissionFlagsBits.ViewChannel] });
                        }
                        if (ownerRole) {
                                overwrites.push({
                                        id: ownerRole.id,
                                        allow: [
                                                PermissionFlagsBits.ViewChannel,
                                                PermissionFlagsBits.SendMessages,
                                                PermissionFlagsBits.ReadMessageHistory,
                                                PermissionFlagsBits.AttachFiles,
                                                PermissionFlagsBits.EmbedLinks
                                        ]
                                });
                        }
                        if (botRole) {
                                overwrites.push({
                                        id: botRole.id,
                                        allow: [
                                                PermissionFlagsBits.ViewChannel,
                                                PermissionFlagsBits.SendMessages,
                                                PermissionFlagsBits.ManageMessages,
                                                PermissionFlagsBits.ReadMessageHistory,
                                                PermissionFlagsBits.ManageChannels
                                        ]
                                });
                        }

                        await channel.permissionOverwrites.set(overwrites);

                        if (channel.parent) {
                                await applyZoneOverwrites(
                                        channel.parent,
                                        {
                                                everyoneRole: guild.roles.everyone,
                                                zoneMemberRole: memberRole,
                                                zoneOwnerRole: ownerRole
                                        },
                                        botRole,
                                        {
                                                panel: await guild.channels.fetch(zone.text_panel_id).catch(() => null),
                                                reception: await guild.channels.fetch(zone.text_reception_id).catch(() => null),
                                                general: await guild.channels.fetch(zone.text_general_id).catch(() => null),
                                                chuchotement: await guild.channels.fetch(zone.text_anon_id).catch(() => null),
                                                voice: await guild.channels.fetch(zone.voice_id).catch(() => null),
                                                interview: channel
                                        }
                                ).catch((err) => {
                                        this.logger?.warn({ err, zoneId: zone.id }, 'Failed to apply zone overwrites to category');
                                });
                        }
                } catch (err) {
                        this.logger?.warn({ err, zoneId: zone.id }, 'Failed to apply interview permissions');
                }
        }

        async #ensurePanelRecord(zoneId) {
                const [rows] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id = ?', [zoneId]);
                if (rows?.length) return rows[0];
                await this.db.query(
                        'INSERT INTO panel_messages (zone_id) VALUES (?) ON DUPLICATE KEY UPDATE zone_id = zone_id',
                        [zoneId]
                ).catch((err) => {
                        this.logger?.warn({ err, zoneId }, 'Failed to insert panel_messages record');
                });
                const [fresh] = await this.db.query('SELECT * FROM panel_messages WHERE zone_id = ?', [zoneId]);
                return fresh?.[0] || null;
        }

        async #syncInviteAnchors(zone) {
                if (!zone?.id) return;
                await this.#cleanupCodeAnchor(zone);
        }

        async #ensureCodeAnchor(zone) {
                const record = await this.#ensurePanelRecord(zone.id);
                const channel = await this.#resolveCodeChannel(zone);
                if (!channel) return null;

                let message = null;
                if (record?.code_anchor_channel_id && record?.code_anchor_message_id) {
                        if (record.code_anchor_channel_id === channel.id) {
                                message = await channel.messages.fetch(record.code_anchor_message_id).catch(() => null);
                        } else {
                                await this.#deleteStoredAnchor(record.code_anchor_channel_id, record.code_anchor_message_id);
                        }
                }

                const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                                .setCustomId(`panel:policy:code:gen:${zone.id}`)
                                .setLabel('Générer un code')
                                .setStyle(ButtonStyle.Secondary)
                );

                const content = (zone.ask_approver_mode || 'owner') === 'owner'
                        ? 'Clique pour générer un code d’invitation à partager au candidat.'
                        : 'Les membres peuvent générer un code temporaire et le transmettre en privé.';

                if (message) {
                        await message.edit({ content, components: [row] }).catch((err) => {
                                if (err?.code === 10008) return;
                                this.logger?.warn({ err, messageId: message?.id, zoneId: zone.id }, 'Failed to edit code anchor');
                        });
                } else {
                        message = await channel.send({ content, components: [row] });
                        if ((zone.ask_approver_mode || 'owner') === 'members') {
                                await message.pin().catch((err) => {
                                        this.logger?.warn({ err, messageId: message?.id, zoneId: zone.id }, 'Failed to pin code anchor');
                                });
                        }
                }

                await this.db.query(
                        'INSERT INTO panel_messages (zone_id, code_anchor_channel_id, code_anchor_message_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE code_anchor_channel_id = VALUES(code_anchor_channel_id), code_anchor_message_id = VALUES(code_anchor_message_id)',
                        [zone.id, message.channelId, message.id]
                );

                return message;
        }

        async #cleanupCodeAnchor(zone) {
                const record = await this.#ensurePanelRecord(zone.id);
                if (!record) return;
                if (record.code_anchor_channel_id && record.code_anchor_message_id) {
                        await this.#deleteStoredAnchor(record.code_anchor_channel_id, record.code_anchor_message_id);
                }
                await this.db.query(
                        'UPDATE panel_messages SET code_anchor_channel_id = NULL, code_anchor_message_id = NULL WHERE zone_id = ?',
                        [zone.id]
                ).catch((err) => {
                        this.logger?.warn({ err, zoneId: zone.id }, 'Failed to clear code anchor references');
                });
        }

        async #deleteStoredAnchor(channelId, messageId) {
                if (!channelId || !messageId) return;
                const channel = await this.client.channels.fetch(channelId).catch(() => null);
                if (!channel?.isTextBased?.()) return;
                const message = await channel.messages.fetch(messageId).catch(() => null);
                if (!message) return;
                await message.unpin().catch((err) => {
                        this.logger?.warn({ err, messageId, channelId }, 'Failed to unpin anchor message');
                });
                await message.delete().catch((err) => {
                        if (err?.code === 10008) return;
                        this.logger?.warn({ err, messageId, channelId }, 'Failed to delete anchor message');
                });
        }

        async #resolveCodeChannel(zone) {
                const approver = zone.ask_approver_mode || 'owner';
                if (approver === 'owner') {
                        return this.#ensureInterviewRoom(zone);
                }
                if (!zone.text_reception_id) return null;
                return this.client.channels.fetch(zone.text_reception_id).catch(() => null);
        }

        async #resolveRequestChannel(zone, ensureInterview = true) {
                const approver = zone.ask_approver_mode || 'owner';
                if (approver === 'owner') {
                        return ensureInterview ? this.#ensureInterviewRoom(zone) : this.#findInterviewRoom(zone);
                }
                if (!zone.text_reception_id) return null;
                return this.client.channels.fetch(zone.text_reception_id).catch(() => null);
        }

        #sanitizeJoinNote(value) {
                if (!value) return null;
                const note = String(value).trim();
                if (!note.length) return null;
                return note.slice(0, 1000);
        }

        #buildJoinRequestEmbed(zone, request, applicantMember, context = {}) {
                const embed = new EmbedBuilder()
                        .setTitle(`Demande d’entrée — ${zone.name}`)
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
                        this.client?.users?.cache?.get(request.user_id)?.displayAvatarURL?.({ size: 128 }) ||
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

        async #grantZoneMembership(zone, userId) {
                if (!zone?.id) return;
                let added = false;

                if (this.services?.zone?.addMember) {
                        try {
                                await this.services.zone.addMember(zone.id, userId);
                                added = true;
                        } catch (err) {
                                this.logger?.warn({ err, zoneId: zone.id, userId }, 'ZoneService addMember failed, falling back');
                        }
                }

                if (!added) {
                        try {
                                const guild = await this.client.guilds.fetch(zone.guild_id);
                                const member = await guild.members.fetch(userId).catch(() => null);
                                const roleMember = zone.role_member_id
                                        ? await guild.roles.fetch(zone.role_member_id).catch(() => null)
                                        : null;
                                if (member && roleMember) {
                                        await member.roles.add(roleMember).catch((err) => {
                                                this.logger?.warn({ err, userId, roleId: roleMember.id, zoneId: zone.id }, 'Failed to add member role');
                                        });
                                }
                                await this.db.query(
                                        'INSERT INTO zone_members (zone_id, user_id, role) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role)',
                                        [zone.id, userId, 'member']
                                );
                                added = true;
                        } catch (err) {
                                this.logger?.warn({ err, zoneId: zone.id, userId }, 'Failed to grant membership fallback');
                        }
                }

                if (added) {
                        const welcomeService = this.client?.context?.services?.welcome;
                        if (welcomeService?.closeOnboardingChannelForUser) {
                                welcomeService
                                        .closeOnboardingChannelForUser(zone.guild_id, userId)
                                        .catch((err) => {
                                                this.logger?.warn({ err, zoneId: zone.id, userId }, 'Failed to cleanup onboarding channel');
                                        });
                        }
                }
        }

        async #dmUser(userId, payload) {
                if (!payload) return;
                const ownerId =
                        this.client?.context?.config?.ownerUserId ||
                        process.env.OWNER_ID ||
                        process.env.OWNER_USER_ID;
                if (!ownerId || !userId || String(ownerId) !== String(userId)) return;
                try {
                        const user = await this.client.users.fetch(userId);
                        await user.send(payload).catch((err) => {
                                if (err?.code === 50007) return;
                                this.logger?.debug({ err, userId }, 'Failed to DM owner');
                        });
                } catch (err) {
                        this.logger?.debug({ err, userId }, 'Failed to fetch owner user for DM');
                }
        }

        async #disableInteractionRow(message) {
                if (!message?.components?.length) return;
                try {
                        const rows = message.components.map((row) => {
                                const newRow = new ActionRowBuilder();
                                for (const component of row.components) {
                                        if (component.data?.type === 2 || component.style) {
                                                newRow.addComponents(ButtonBuilder.from(component).setDisabled(true));
                                        }
                                }
                                return newRow;
                        });
                        await message.edit({ components: rows }).catch((err) => {
                                if (err?.code === 10008) return;
                                this.logger?.warn({ err, messageId: message?.id }, 'Failed to disable interaction row');
                        });
                } catch (err) {
                        this.logger?.debug({ err }, 'Failed to build disabled interaction rows');
                }
        }

        async #canModerateRequests(zone, userId, member = null) {
                if (await this.#isZoneOwner(zone, userId)) return true;
                const approver = zone.ask_approver_mode || 'owner';
                if (approver === 'members') {
                        if (member) {
                                return member.roles?.cache?.has(zone.role_member_id) || false;
                        }
                        try {
                                const guild = await this.client.guilds.fetch(zone.guild_id);
                                const fetchedMember = await guild.members.fetch(userId).catch(() => null);
                                return fetchedMember?.roles?.cache?.has(zone.role_member_id) || false;
                        } catch (err) {
                                this.logger?.debug({ err, userId, zoneId: zone.id }, 'Failed to fetch member for moderation check');
                                return false;
                        }
                }
                return false;
        }

        #generateCode() {
                const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
                let output = '';
                for (let i = 0; i < 6; i += 1) {
                        const idx = crypto.randomInt(0, alphabet.length);
                        output += alphabet[idx];
                }
                return output;
        }
}

module.exports = { PolicyService };
