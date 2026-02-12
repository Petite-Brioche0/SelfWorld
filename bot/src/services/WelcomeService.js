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

class WelcomeService {
        constructor(client, db, logger, services = {}) {
                this.client = client;
                this.db = db;
                this.logger = logger;
                this.services = services;
                this.pageSize = 3;
        }

        buildWizardPayload(guildId = null) {
                return this.#buildWizardPayload(guildId);
        }

        async sendWizardToUser(target, options = {}) {
                const guildId = options.guildId || target?.guild?.id || target?.guildId || null;
                const payload = this.#buildWizardPayload(guildId);
                if (options.mentionId) {
                        payload.content = `<@${options.mentionId}>`;
                }

                const isGuildTextTarget =
                        typeof target?.isTextBased === 'function' &&
                        target.isTextBased() &&
                        (target.guildId || target.guild?.id);
                if (isGuildTextTarget && typeof target?.send === 'function') {
                        return target.send(payload);
                }

                const targetUserId = target?.user?.id || target?.id || null;
                if (!this.#isOwnerUser(targetUserId)) {
                        throw new Error('Direct messages disabled for non-owner users.');
                }

                if (typeof target?.send === 'function') {
                        return target.send(payload);
                }

                if (target?.user && typeof target.user.send === 'function') {
                        return target.user.send(payload);
                }

                throw new Error('Invalid welcome target');
        }

        async handleButton(interaction) {
                const id = interaction.customId || '';

                if (id === 'welcome:browse') {
                        return this.#handleBrowse(interaction, 0, { update: false });
                }

                if (id.startsWith('welcome:browse:prev:') || id.startsWith('welcome:browse:next:')) {
                        const parts = id.split(':');
                        const page = Number(parts.at(-1));
                        const targetPage = Number.isFinite(page) ? page : 0;
                        return this.#handleBrowse(interaction, targetPage, { update: true });
                }

                if (id.startsWith('welcome:zone:join:')) {
                        const zoneId = Number(id.split(':').at(-1));
                        return this.#handleZoneJoin(interaction, zoneId);
                }

                if (id === 'welcome:joincode') {
                        return this.#showJoinCodeModal(interaction);
                }

                if (id.startsWith('welcome:request')) {
                        const parts = id.split(':');
                        const requestedGuildId = parts.length >= 3 ? parts[2] : null;
                        const guildId = requestedGuildId || interaction.guildId || interaction.guild?.id || null;
                        return this.#showZoneRequestModal(interaction, guildId);
                }

                return false;
        }

        async handleModal(interaction) {
                const id = interaction.customId || '';

                if (id === 'welcome:joincode:modal') {
                        return this.#handleJoinCodeModal(interaction);
                }

                return false;
        }

        #buildWizardPayload(guildId = null) {
                const intro = new EmbedBuilder()
                        .setTitle('Bienvenue !')
                        .setColor(0x5865f2)
                        .setDescription(
                                [
                                        '• Les zones sont des espaces isolés : seuls leurs membres voient les discussions.',
                                        '• Pas de liste globale des membres, tu restes discret tant que tu n’entres pas.',
                                        '• Pour rejoindre : découvre les zones ouvertes, demande l’accès ou saisis un code reçu.',
                                        '• Pour créer ta zone, utilise « Demander une zone » et remplis la demande.',
                                        '• Reste respectueux : pas de doxx, pas de harcèlement, respecte les règles du serveur.'
                                ].join('\n')
                        );

                const assistant = new EmbedBuilder()
                        .setTitle('Assistant de zones')
                        .setDescription('Choisis une option ci-dessous pour commencer.')
                        .setColor(0x5865f2);

                const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('welcome:browse').setLabel('Découvrir les zones').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('welcome:joincode').setLabel('Rejoindre via un code').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder()
                                .setCustomId(guildId ? `welcome:request:${guildId}` : 'welcome:request')
                                .setLabel('Demander une zone')
                                .setStyle(ButtonStyle.Secondary)
                );

                return { embeds: [intro, assistant], components: [row] };
        }

        async #handleBrowse(interaction, page, { update }) {
                try {
                        const payload = await this.#buildBrowsePayload(page);

                        if (update) {
                                return interaction.update(payload);
                        }

                        const response = { ...payload };
                        const flags = this.#resolveEphemeralFlag(interaction);
                        if (flags) {
                                response.flags = flags;
                        }
                        return interaction.reply(response);
                } catch (err) {
                        this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to display zone browser');
                        const message = {
                                content: '⚠️ **Erreur de chargement**\n\nImpossible de charger les zones. Réessaye dans quelques instants.'
                        };
                        const fallbackFlags = this.#resolveEphemeralFlag(interaction);
                        if (fallbackFlags) {
                                message.flags = fallbackFlags;
                        }
                        if (interaction.deferred || interaction.replied || update) {
                                return interaction.followUp(message).catch((err) => {
                                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                        this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send zone browser error message');
                                });
                        }
                        return interaction.reply(message).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send zone browser error message');
                        });
                }
        }

        async #buildBrowsePayload(page) {
                const policyService = this.services.policy;
                if (!policyService?.listDiscoverableZones) {
                        throw new Error('Policy service indisponible');
                }

                const desiredPage = Math.max(0, Number.isFinite(page) ? page : 0);
                const initial = await policyService.listDiscoverableZones({
                        limit: this.pageSize,
                        offset: desiredPage * this.pageSize
                });

                const total = initial.total || 0;
                const totalPages = Math.max(1, Math.ceil(total / this.pageSize));
                const safePage = Math.min(desiredPage, totalPages - 1);

                let zones = initial.zones || [];
                if (safePage !== desiredPage) {
                        const fallback = await policyService.listDiscoverableZones({
                                limit: this.pageSize,
                                offset: safePage * this.pageSize
                        });
                        zones = fallback.zones || [];
                }

                const embeds = [];
                const components = [];

                if (!zones.length) {
                        embeds.push(
                                new EmbedBuilder()
                                        .setTitle('Aucune zone ouverte')
                                        .setDescription('Reviens plus tard, de nouvelles zones arriveront bientôt !')
                                        .setColor(0x5865f2)
                        );
                } else {
                        for (const zone of zones) {
                                const activity = await this.#fetchActivitySummary(zone.id);
                                const memberCount = await this.#fetchZoneMemberCount(zone.id);
                                const embed = this.#buildZoneEmbed(zone, activity, memberCount);

                                const activityService = this.services?.activity;
                                if (activityService?.getZoneActivityScore && activityService?.buildProgressBar) {
                                        try {
                                                const score = await activityService.getZoneActivityScore(zone.id, 14);
                                                const bar = activityService.buildProgressBar(score);
                                                const pct = (score * 100) | 0;
                                                embed.addFields({ name: 'Activité', value: `${bar}  ${pct}%`, inline: false });
                                        } catch (err) {
                                                this.logger?.warn({ err, zoneId: zone.id }, 'Failed to compute activity score for browse card');
                                        }
                                }

                                embeds.push(embed);
                                components.push(this.#buildZoneActionRow(zone));
                        }
                }

                const paginationRow = this.#buildPaginationRow(safePage, totalPages);
                if (paginationRow) components.push(paginationRow);

                return { embeds, components };
        }

        #buildZoneEmbed(zone, activity, memberCount) {
                const embed = new EmbedBuilder()
                        .setTitle(zone.profile_title || zone.name)
                        .setColor(this.#parseColor(zone.profile_color))
                        .setDescription(this.#truncate(zone.profile_desc || 'Pas encore de description.', 300));

                const tags = Array.isArray(zone.profile_tags) ? zone.profile_tags.slice(0, 5) : [];
                if (tags.length) {
                        embed.addFields({ name: 'Tags', value: tags.map((tag) => `#${tag}`).join(' '), inline: false });
                }

                embed.addFields({
                        name: 'Activité (14 jours)',
                        value: `💬 ${activity.msgs} msgs • 🔊 ${activity.voice} min voix`,
                        inline: false
                });

                embed.addFields({ name: 'Membres', value: `${memberCount}`, inline: true });

                if (zone.policy === 'ask') {
                        embed.setFooter({ text: 'Admission sur demande' });
                }

                return embed;
        }

        #buildZoneActionRow(zone) {
                const joinLabel = zone.policy === 'open' ? 'Rejoindre' : 'Demander à rejoindre';
                return new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                                .setCustomId(`welcome:zone:join:${zone.id}`)
                                .setLabel(joinLabel)
                                .setStyle(ButtonStyle.Success)
                );
        }

        #buildPaginationRow(page, totalPages) {
                if (totalPages <= 1) return null;
                const prevTarget = Math.max(0, page - 1);
                const nextTarget = Math.min(totalPages - 1, page + 1);

                return new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                                .setCustomId(`welcome:browse:prev:${prevTarget}`)
                                .setLabel('◀︎ Précédent')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(page === 0),
                        new ButtonBuilder()
                                .setCustomId('welcome:browse:status')
                                .setLabel(`Page ${page + 1}/${totalPages}`)
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true),
                        new ButtonBuilder()
                                .setCustomId(`welcome:browse:next:${nextTarget}`)
                                .setLabel('Suivant ▶︎')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(page >= totalPages - 1)
                );
        }

        async #handleZoneJoin(interaction, zoneId) {
                if (!zoneId) {
                        return this.#sendReply(interaction, { content: '❌ **Zone invalide**\n\nCette zone n\'existe plus ou est inaccessible.' });
                }

                try {
                        const policyService = this.services.policy;
                        const zone = await policyService.getZone(zoneId);
                        if (!zone) {
                                return this.#sendReply(interaction, { content: '❌ **Zone introuvable**\n\nCette zone n\'existe plus ou a été fermée.' });
                        }

                        if (await policyService.isUserMember(zone.id, interaction.user.id)) {
                                return this.#sendReply(interaction, { content: '✅ **Déjà membre**\n\nTu fais déjà partie de cette zone !' });
                        }

                        if (zone.policy === 'open') {
                                await policyService.grantMembership(zone.id, interaction.user.id);
                                return this.#sendReply(interaction, {
                                        content: `✅ **Bienvenue !**\n\nTu as rejoint **${zone.name}** et tu as maintenant accès aux canaux.`
                                });
                        }

                        if (zone.policy === 'ask') {
                                const joinMode = zone.ask_join_mode || 'request';
                                if (!['request', 'both'].includes(joinMode)) {
                                        return this.#sendReply(interaction, {
                                                content: '🔐 **Code requis**\n\nCette zone nécessite un code d\'invitation.\n\n> 💡 *Utilise le bouton « Rejoindre via un code » pour accéder à cette zone.*'
                                        });
                                }

                                const result = await policyService.createJoinRequest(zone.id, interaction.user.id, {
                                        note: null
                                });

                                if (result.status === 'already-member') {
                                        return this.#sendReply(interaction, { content: '✅ **Déjà membre**\n\nTu fais déjà partie de cette zone !' });
                                }

                                if (result.status === 'already-requested') {
                                        return this.#sendReply(interaction, {
                                                content: '⏳ **Demande en attente**\n\nTa demande est déjà en cours de traitement par les responsables de la zone.'
                                        });
                                }

                                const guild = await this.client.guilds.fetch(zone.guild_id);
                                const applicant = await guild.members.fetch(interaction.user.id).catch(() => null);
                                await policyService.postJoinRequestCard(zone, result.request, applicant, {
                                        source: 'Assistant de bienvenue'
                                });

                                await this.#sendReply(interaction, {
                                        content: '✅ **Demande envoyée !**\n\nTa demande a été envoyée aux responsables de la zone. Tu seras notifié dès qu\'elle sera traitée.'
                                });

                                await this.#notifyUser(interaction.user.id, {
                                        content: `📬 **Demande transmise**\n\nTa demande pour **${zone.name}** a bien été transmise. Tu seras notifié(e) dès qu'elle sera traitée.`
                                });

                                return true;
                        }

                        return this.#sendReply(interaction, { content: '⚠️ **Zone indisponible**\n\nCette zone n\'est pas disponible pour le moment. Réessaye plus tard ou contacte les administrateurs.' });
                } catch (err) {
                        this.logger?.warn({ err, zoneId, userId: interaction.user.id }, 'Failed to process zone join');
                        return this.#sendReply(interaction, {
                                content: '❌ **Erreur**\n\nImpossible de rejoindre la zone pour le moment. Réessaye dans quelques instants.'
                        });
                }
        }

        async #showJoinCodeModal(interaction) {
                const modal = new ModalBuilder().setCustomId('welcome:joincode:modal').setTitle('Rejoindre une zone avec un code');

                const codeInput = new TextInputBuilder()
                        .setCustomId('welcomeJoinCodeInput')
                        .setLabel('Code d’invitation')
                        .setStyle(TextInputStyle.Short)
                        .setRequired(true)
                        .setMaxLength(6)
                        .setMinLength(6)
                        .setPlaceholder('ABC123');

                modal.addComponents(new ActionRowBuilder().addComponents(codeInput));

                return interaction.showModal(modal);
        }

        async #showZoneRequestModal(interaction, guildId = null) {
                const modalId = guildId ? `welcome:request:modal:${guildId}` : 'welcome:request:modal';
                const modal = new ModalBuilder().setCustomId(modalId).setTitle('Demander une nouvelle zone');

                modal.addComponents(
                        new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                        .setCustomId('welcomeRequestName')
                                        .setLabel('Nom de la zone')
                                        .setStyle(TextInputStyle.Short)
                                        .setRequired(true)
                                        .setMaxLength(64)
                        ),
                        new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                        .setCustomId('welcomeRequestPitch')
                                        .setLabel('Description / objectif')
                                        .setStyle(TextInputStyle.Paragraph)
                                        .setRequired(true)
                                        .setMaxLength(500)
                        ),
                        new ActionRowBuilder().addComponents(
                                new TextInputBuilder()
                                        .setCustomId('welcomeRequestTags')
                                        .setLabel('Tags (facultatif)')
                                        .setStyle(TextInputStyle.Short)
                                        .setRequired(false)
                                        .setMaxLength(120)
                        )
                );

                return interaction.showModal(modal);
        }

        async #handleJoinCodeModal(interaction) {
                const code = interaction.fields.getTextInputValue('welcomeJoinCodeInput')?.trim().toUpperCase();

                try {
                        const result = await this.services.policy.redeemInviteCode(code, interaction.user.id);
                        if (result.status === 'already-member') {
                                return this.#sendReply(interaction, {
                                        content: '✅ **Déjà membre**\n\nTu es déjà membre de cette zone — aucun code nécessaire.'
                                });
                        }

                        await this.#sendReply(interaction, {
                                content: `✅ **Bienvenue !**\n\nTu as rejoint **${result.zone.name}** avec succès !`
                        });

                        await this.#notifyUser(interaction.user.id, {
                                content: `✅ **Code validé**\n\nTon code a été validé et tu rejoins **${result.zone.name}**.`
                        });

                        return true;
                } catch (err) {
                        this.logger?.warn({ err, code, userId: interaction.user.id }, 'Invite code redemption failed');
                        return this.#sendReply(interaction, {
                                content: err?.message ? `❌ **Erreur**\n\n${err.message}` : '❌ **Code invalide**\n\nCe code est invalide ou a expiré. Vérifie le code et réessaye.'
                        });
                }
        }

        #buildZoneDetailsEmbed(zone, activity, memberCount) {
                const embed = this.#buildZoneEmbed(zone, activity, memberCount);
                embed.setDescription(this.#truncate(zone.profile_desc || 'Pas encore de description.', 1000));
                embed.addFields({ name: 'Politique', value: zone.policy === 'open' ? 'Ouverte' : 'Sur demande', inline: true });
                return embed;
        }

        async #fetchActivitySummary(zoneId) {
                try {
                        const [rows] = await this.db.query(
                                `SELECT COALESCE(SUM(msgs),0) AS msgs, COALESCE(SUM(reacts),0) AS reacts, COALESCE(SUM(voice_minutes),0) AS voice
                                FROM zone_activity
                                WHERE zone_id = ? AND day >= DATE_SUB(CURRENT_DATE(), INTERVAL 14 DAY)`,
                                [zoneId]
                        );
                        const row = rows?.[0] || {};
                        return {
                                msgs: Number(row.msgs) || 0,
                                reacts: Number(row.reacts) || 0,
                                voice: Number(row.voice) || 0
                        };
                } catch (err) {
                        this.logger?.warn({ err, zoneId }, 'Failed to fetch activity summary');
                        return { msgs: 0, reacts: 0, voice: 0 };
                }
        }

        async #fetchZoneMemberCount(zoneId) {
                try {
                        const [rows] = await this.db.query('SELECT COUNT(*) AS total FROM zone_members WHERE zone_id = ?', [zoneId]);
                        return Number(rows?.[0]?.total) || 0;
                } catch (err) {
                        this.logger?.warn({ err, zoneId }, 'Failed to fetch zone member count');
                        return 0;
                }
        }

        async #sendReply(interaction, payload) {
                const response = { ...payload };
                const flags = this.#resolveEphemeralFlag(interaction);
                if (flags) {
                        response.flags = flags;
                }

                if (interaction.deferred || interaction.replied) {
                        return interaction.followUp(response).catch((err) => {
                                if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                                this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send welcome reply');
                        });
                }

                return interaction.reply(response).catch((err) => {
                        if (err?.code === 10062 || err?.rawError?.code === 10062) return;
                        this.logger?.warn({ err, userId: interaction?.user?.id }, 'Failed to send welcome reply');
                });
        }

        #resolveEphemeralFlag(interaction) {
                if (interaction?.forceWelcomeEphemeral) return MessageFlags.Ephemeral;
                if (interaction?.inGuild?.()) return MessageFlags.Ephemeral;
                return null;
        }

        #getOwnerId() {
                return this.client?.context?.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID || null;
        }

        #isOwnerUser(userId) {
                const ownerId = this.#getOwnerId();
                return ownerId && userId && String(ownerId) === String(userId);
        }

        async #notifyUser(userId, payload) {
                if (!payload) return;
                if (!this.#isOwnerUser(userId)) return;
                try {
                        const user = await this.client.users.fetch(userId);
                        await user.send(payload).catch((err) => {
                                this.logger?.warn({ err, userId }, 'Failed to send DM to owner');
                        });
                } catch (err) {
                        this.logger?.warn({ err, userId }, 'Failed to fetch owner for DM');
                }
        }

        async closeOnboardingChannelForUser(guildId, userId) {
                return;
        }

        #parseColor(color) {
                if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
                        return 0x5865f2;
                }
                return parseInt(color.replace('#', ''), 16);
        }

        #truncate(text, limit) {
                const value = String(text || '');
                if (value.length <= limit) return value;
                return `${value.slice(0, limit - 1)}…`;
        }
}

module.exports = { WelcomeService };
