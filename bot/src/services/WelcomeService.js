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

        async sendWizardToUser(target, options = {}) {
                const payload = this.#buildWizardPayload();
                if (options.mentionId) {
                        payload.content = `<@${options.mentionId}>`;
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

                if (id.startsWith('welcome:page:')) {
                        const parts = id.split(':');
                        const page = Number(parts.at(-1));
                        const targetPage = Number.isFinite(page) ? page : 0;
                        return this.#handleBrowse(interaction, targetPage, { update: true });
                }

                if (id.startsWith('welcome:zone:info:')) {
                        const zoneId = Number(id.split(':').at(-1));
                        return this.#handleZoneInfo(interaction, zoneId);
                }

                if (id.startsWith('welcome:zone:join:')) {
                        const zoneId = Number(id.split(':').at(-1));
                        return this.#handleZoneJoin(interaction, zoneId);
                }

                if (id === 'welcome:joincode') {
                        return this.#showJoinCodeModal(interaction);
                }

                if (id === 'welcome:request') {
                        return this.#showZoneRequestModal(interaction);
                }

                return false;
        }

        async handleModal(interaction) {
                const id = interaction.customId || '';

                if (id === 'welcome:joincode:modal') {
                        return this.#handleJoinCodeModal(interaction);
                }

                if (id === 'welcome:request:modal') {
                        return this.#handleZoneRequestModal(interaction);
                }

                return false;
        }

        #buildWizardPayload() {
                const embed = new EmbedBuilder()
                        .setTitle('👋 Bienvenue sur le serveur !')
                        .setDescription(
                                'Explore les zones disponibles, rejoins celles qui t’intéressent et découvre la communauté.'
                        )
                        .setColor(0x5865f2);

                const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('welcome:browse').setLabel('Découvrir les zones').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId('welcome:joincode').setLabel('Rejoindre via un code').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('welcome:request').setLabel('Demander une zone').setStyle(ButtonStyle.Secondary)
                );

                return { embeds: [embed], components: [row] };
        }

        async #handleBrowse(interaction, page, { update }) {
                try {
                        const payload = await this.#buildBrowsePayload(page);

                        if (update) {
                                return interaction.update(payload);
                        }

                        const response = { ...payload };
                        if (interaction.inGuild()) {
                                response.flags = MessageFlags.Ephemeral;
                        }
                        return interaction.reply(response);
                } catch (err) {
                        this.logger?.warn({ err, userId: interaction.user.id }, 'Failed to display zone browser');
                        const message = {
                                content: 'Impossible de charger les zones actuellement.',
                                flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined
                        };
                        if (interaction.deferred || interaction.replied || update) {
                                return interaction.followUp(message).catch(() => {});
                        }
                        return interaction.reply(message).catch(() => {});
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
                        name: 'Activité (7 jours)',
                        value: `💬 ${activity.msgs} msgs • 🔁 ${activity.reacts} réactions • 🔊 ${activity.voice} min voix`,
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
                                .setCustomId(`welcome:zone:info:${zone.id}`)
                                .setLabel('Plus d’infos')
                                .setStyle(ButtonStyle.Secondary),
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
                                .setCustomId(`welcome:page:prev:${prevTarget}`)
                                .setLabel('◀︎ Précédent')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(page === 0),
                        new ButtonBuilder()
                                .setCustomId('welcome:page:status')
                                .setLabel(`Page ${page + 1}/${totalPages}`)
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(true),
                        new ButtonBuilder()
                                .setCustomId(`welcome:page:next:${nextTarget}`)
                                .setLabel('Suivant ▶︎')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(page >= totalPages - 1)
                );
        }

        async #handleZoneInfo(interaction, zoneId) {
                if (!zoneId) {
                        return this.#sendReply(interaction, { content: 'Zone inconnue.' });
                }

                try {
                        const zone = await this.services.policy.getZone(zoneId);
                        if (!zone) {
                                return this.#sendReply(interaction, { content: 'Zone introuvable.' });
                        }

                        const activity = await this.#fetchActivitySummary(zone.id);
                        const memberCount = await this.#fetchZoneMemberCount(zone.id);
                        const embed = this.#buildZoneDetailsEmbed(zone, activity, memberCount);
                        const activityService = this.services?.activity;
                        if (activityService?.getZoneActivityScore && activityService?.buildProgressBar) {
                                try {
                                        const score = await activityService.getZoneActivityScore(zone.id, 14);
                                        const bar = activityService.buildProgressBar(score);
                                        const pct = (score * 100) | 0;
                                        embed.addFields({ name: 'Activité', value: `${bar}  ${pct}%`, inline: false });
                                } catch (err) {
                                        this.logger?.warn({ err, zoneId }, 'Failed to compute activity score for zone info');
                                }
                        }
                        return this.#sendReply(interaction, { embeds: [embed] });
                } catch (err) {
                        this.logger?.warn({ err, zoneId }, 'Failed to fetch zone info');
                        return this.#sendReply(interaction, { content: 'Impossible de récupérer les informations.' });
                }
        }

        async #handleZoneJoin(interaction, zoneId) {
                if (!zoneId) {
                        return this.#sendReply(interaction, { content: 'Zone invalide.' });
                }

                try {
                        const policyService = this.services.policy;
                        const zone = await policyService.getZone(zoneId);
                        if (!zone) {
                                return this.#sendReply(interaction, { content: 'Zone introuvable.' });
                        }

                        if (await policyService.isUserMember(zone.id, interaction.user.id)) {
                                return this.#sendReply(interaction, { content: 'Tu fais déjà partie de cette zone.' });
                        }

                        if (zone.policy === 'open') {
                                await policyService.grantMembership(zone.id, interaction.user.id);
                                return this.#sendReply(interaction, {
                                        content: `Bienvenue dans **${zone.name}** ! Tu as maintenant accès aux canaux.`
                                });
                        }

                        if (zone.policy === 'ask') {
                                const joinMode = zone.ask_join_mode || 'request';
                                if (!['request', 'both'].includes(joinMode)) {
                                        return this.#sendReply(interaction, {
                                                content: 'Cette zone nécessite un code. Utilise le bouton « Rejoindre via un code ». '
                                        });
                                }

                                const result = await policyService.createJoinRequest(zone.id, interaction.user.id, {
                                        note: null
                                });

                                if (result.status === 'already-member') {
                                        return this.#sendReply(interaction, { content: 'Tu fais déjà partie de cette zone.' });
                                }

                                if (result.status === 'already-requested') {
                                        return this.#sendReply(interaction, {
                                                content: 'Ta demande est déjà en cours de traitement.'
                                        });
                                }

                                const guild = await this.client.guilds.fetch(zone.guild_id);
                                const applicant = await guild.members.fetch(interaction.user.id).catch(() => null);
                                await policyService.postJoinRequestCard(zone, result.request, applicant, {
                                        source: 'Assistant de bienvenue'
                                });

                                await this.#sendReply(interaction, {
                                        content: '✅ Ta demande a été envoyée aux responsables de la zone.'
                                });

                                await this.#notifyUser(interaction.user.id, {
                                        content: `Ta demande pour **${zone.name}** a bien été transmise. Tu seras notifié(e) dès qu’elle sera traitée.`
                                });

                                return true;
                        }

                        return this.#sendReply(interaction, { content: 'La zone n’est pas disponible pour le moment.' });
                } catch (err) {
                        this.logger?.warn({ err, zoneId, userId: interaction.user.id }, 'Failed to process zone join');
                        return this.#sendReply(interaction, {
                                content: 'Impossible de rejoindre la zone pour le moment. Réessaie plus tard.'
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

        async #showZoneRequestModal(interaction) {
                const modal = new ModalBuilder().setCustomId('welcome:request:modal').setTitle('Demander une nouvelle zone');

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
                                        content: 'Tu es déjà membre de cette zone — aucun code nécessaire.'
                                });
                        }

                        await this.#sendReply(interaction, {
                                content: `✅ Bienvenue dans **${result.zone.name}** !`
                        });

                        await this.#notifyUser(interaction.user.id, {
                                content: `Ton code a été validé et tu rejoins **${result.zone.name}**.`
                        });

                        return true;
                } catch (err) {
                        this.logger?.warn({ err, code, userId: interaction.user.id }, 'Invite code redemption failed');
                        return this.#sendReply(interaction, {
                                content: err?.message ? `❌ ${err.message}` : 'Code invalide ou expiré.'
                        });
                }
        }

        async #handleZoneRequestModal(interaction) {
                        const name = interaction.fields.getTextInputValue('welcomeRequestName')?.trim().slice(0, 64) || 'Sans nom';
                        const pitch = interaction.fields.getTextInputValue('welcomeRequestPitch')?.trim().slice(0, 500) || '—';
                        const tags = interaction.fields
                                .getTextInputValue('welcomeRequestTags')
                                ?.split(',')
                                .map((entry) => entry.trim())
                                .filter((entry) => entry.length)
                                .slice(0, 8);

                const embed = new EmbedBuilder()
                        .setTitle('Nouvelle demande de zone')
                        .setDescription(pitch)
                        .addFields(
                                { name: 'Proposée par', value: `<@${interaction.user.id}> (${interaction.user.id})`, inline: false },
                                { name: 'Nom suggéré', value: name, inline: false },
                                { name: 'Tags', value: tags?.length ? tags.join(', ') : '—', inline: false }
                        )
                        .setTimestamp(new Date())
                        .setColor(0x5865f2);

                let delivered = false;
                const ownerId = this.client?.context?.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID;
                if (ownerId) {
                        try {
                                const ownerUser = await this.client.users.fetch(ownerId);
                                await ownerUser.send({ embeds: [embed] });
                                delivered = true;
                        } catch (err) {
                                this.logger?.warn({ err, ownerId }, 'Failed to DM owner with zone request');
                        }
                }

                if (!delivered) {
                        this.logger?.info({ name, userId: interaction.user.id }, 'Zone request could not be delivered directly');
                }

                return this.#sendReply(interaction, {
                        content: 'Merci ! Ta demande a été transmise à l’équipe.'
                });
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
                                WHERE zone_id = ? AND day >= DATE_SUB(CURRENT_DATE(), INTERVAL 7 DAY)`,
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
                if (interaction.inGuild()) {
                        response.flags = MessageFlags.Ephemeral;
                }

                if (interaction.deferred || interaction.replied) {
                        return interaction.followUp(response).catch(() => {});
                }

                return interaction.reply(response).catch(() => {});
        }

        async #notifyUser(userId, payload) {
                if (!payload) return;
                try {
                        const user = await this.client.users.fetch(userId);
                        await user.send(payload).catch(() => {});
                } catch {}
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
