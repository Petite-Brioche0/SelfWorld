
const crypto = require('crypto');
const {
        WebhookClient,
        EmbedBuilder,
        MessageFlags,
        ActionRowBuilder,
        ButtonBuilder,
        ButtonStyle,
        StringSelectMenuBuilder,
        ChannelType
} = require('discord.js');
const { generateAnonName } = require('../utils/anonNames');

class AnonService {
        constructor(client, db, logger = null) {
                this.client = client;
                this.db = db;
                this.logger = logger;
                this._suggestionContexts = new Map();
                this._openPanels = new Map();
                this._guildSettings = new Map();
        }

        #cleanupSuggestionContexts(limit = 300) {
                if (this._suggestionContexts.size <= limit) return;
                const now = Date.now();
                for (const [key, ctx] of this._suggestionContexts) {
                        if (!ctx?.expiresAt || ctx.expiresAt <= now) {
                                this._suggestionContexts.delete(key);
                        }
                        if (this._suggestionContexts.size <= limit) break;
                }
        }

        #storeSuggestionContext(messageId, context) {
                if (!messageId || !context) return;
                const key = String(messageId);
                const enriched = { ...context, messageId: key, expiresAt: Date.now() + 24 * 60 * 60 * 1000 };
                this._suggestionContexts.set(key, enriched);
                this.#cleanupSuggestionContexts();
        }

        #getSuggestionContext(target) {
                const key = target?.id ? String(target.id) : String(target?.message?.id || target);
                if (!key) return null;
                const ctx = this._suggestionContexts.get(key);
                if (!ctx) return null;
                if (ctx.expiresAt && ctx.expiresAt < Date.now()) {
                        this._suggestionContexts.delete(key);
                        return null;
                }
                return ctx;
        }

        #removeSuggestionContext(target) {
                const key = target?.id ? String(target.id) : String(target?.message?.id || target);
                if (!key) return;
                this._suggestionContexts.delete(key);
        }

        async #getGuildSettings(guildId) {
                if (!guildId) {
                        return { threshold: 10, requestsChannelId: null };
                }
                const key = String(guildId);
                const cached = this._guildSettings.get(key);
                if (cached && Date.now() - (cached.cachedAt || 0) < 5 * 60 * 1000) {
                        return cached;
                }
                try {
                        const [rows] = await this.db.query(
                                'SELECT anon_threshold, requests_channel_id FROM settings WHERE guild_id = ?',
                                [guildId]
                        );
                        const row = rows?.[0] || {};
                        const threshold = Number(row.anon_threshold) > 0 ? Number(row.anon_threshold) : 10;
                        const requestsChannelId = row.requests_channel_id || process.env.ZONE_REQUESTS_CHANNEL_ID || null;
                        const settings = { threshold, requestsChannelId, cachedAt: Date.now() };
                        this._guildSettings.set(key, settings);
                        return settings;
                } catch (err) {
                        this.logger?.warn?.({ err, guildId }, 'Failed to fetch anon settings');
                        return { threshold: 10, requestsChannelId: null };
                }
        }

        async #incrementDailyCount(guildId, userId) {
                if (!guildId || !userId) return 0;
                try {
                        await this.db.query(
                                `INSERT INTO anon_daily_counts (guild_id, day, user_id, count)
                                VALUES (?, CURRENT_DATE(), ?, 1)
                                ON DUPLICATE KEY UPDATE count = count + 1`,
                                [guildId, String(userId)]
                        );
                        const [rows] = await this.db.query(
                                'SELECT count FROM anon_daily_counts WHERE guild_id = ? AND day = CURRENT_DATE() AND user_id = ?',
                                [guildId, String(userId)]
                        );
                        return Number(rows?.[0]?.count || 0);
                } catch (err) {
                        this.logger?.warn?.({ err, guildId, userId }, 'Failed to increment anon counter');
                        return 0;
                }
        }

        #buildSuggestionButtons({ disabled = false } = {}) {
                return new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                                .setCustomId('temp:fromAnon:create:closed')
                                .setLabel('Groupe fermé')
                                .setStyle(ButtonStyle.Primary)
                                .setDisabled(disabled),
                        new ButtonBuilder()
                                .setCustomId('temp:fromAnon:create:open')
                                .setLabel('Groupe ouvert')
                                .setStyle(ButtonStyle.Secondary)
                                .setDisabled(disabled)
                );
        }

        async #sendAnonSuggestion(message, zoneContext, count, threshold) {
                if (!message?.author) return;
                const content = [
                        `👏 Belle participation aujourd’hui (${count}/${threshold}).`,
                        '📥 Souhaites-tu créer un salon temporaire anonyme ?'
                ].join('\n');
                const components = [this.#buildSuggestionButtons()];
                const payload = { content, components, allowedMentions: { parse: [] } };
                let sent = null;
                try {
                        const dm = await message.author.createDM();
                        sent = await dm.send(payload);
                        this.#storeSuggestionContext(sent.id, {
                                userId: message.author.id,
                                guildId: message.guild.id,
                                channelId: message.channelId,
                                zoneId: zoneContext.zoneId,
                                zoneName: zoneContext.zoneName,
                                zoneColor: zoneContext.zoneColor,
                                requesterAnon: zoneContext.requesterAnon,
                                source: 'dm'
                        });
                        return;
                } catch (err) {
                        this.logger?.debug?.({ err }, 'Failed to DM anon suggestion');
                }
                try {
                        sent = await message.reply({
                                ...payload,
                                flags: MessageFlags.Ephemeral
                        });
                } catch (err) {
                        this.logger?.warn?.({ err, messageId: message.id }, 'Failed ephemeral fallback anon suggestion');
                        try {
                                sent = await message.reply({ content, components, allowedMentions: { parse: [] } });
                                setTimeout(() => {
                                        sent?.delete?.().catch(() => {});
                                }, 60_000);
                        } catch (fallbackErr) {
                                this.logger?.warn?.({ err: fallbackErr }, 'Failed channel fallback anon suggestion');
                        }
                }
                if (sent) {
                        this.#storeSuggestionContext(sent.id, {
                                userId: message.author.id,
                                guildId: message.guild.id,
                                channelId: message.channelId,
                                zoneId: zoneContext.zoneId,
                                zoneName: zoneContext.zoneName,
                                zoneColor: zoneContext.zoneColor,
                                requesterAnon: zoneContext.requesterAnon,
                                source: 'channel'
                        });
                }
        }

        async #maybeSuggestTempGroup(message, zoneRow, zoneColor, count, threshold) {
                if (!threshold || threshold <= 0) return;
                if (!count || count !== threshold) return;
                const requesterAnon = this.#buildAnonName(message.author.id, zoneRow?.id || 0);
                await this.#sendAnonSuggestion(
                        message,
                        {
                                zoneId: zoneRow?.id || 0,
                                zoneName: zoneRow?.name || null,
                                zoneColor,
                                requesterAnon
                        },
                        count,
                        threshold
                );
        }

        async #fetchGuild(guildId) {
                if (!guildId) return null;
                try {
                        return await this.client.guilds.fetch(guildId);
                } catch (err) {
                        this.logger?.warn?.({ err, guildId }, 'Failed to fetch guild');
                        return null;
                }
        }

        async #ensureRequestsChannel(guild, settings) {
                if (!guild) return null;
                const { requestsChannelId } = settings || (await this.#getGuildSettings(guild.id));
                if (requestsChannelId) {
                        const existing = await guild.channels.fetch(requestsChannelId).catch(() => null);
                        if (existing) return existing;
                }
                let category = guild.channels.cache.find(
                        (channel) => channel.type === ChannelType.GuildCategory && channel.name.toLowerCase().includes('notification')
                );
                if (!category) {
                        category = await guild.channels
                                .create({ name: 'Notification', type: ChannelType.GuildCategory, reason: 'Salon d’annonces anonymes' })
                                .catch((err) => {
                                        this.logger?.warn?.({ err, guildId: guild.id }, 'Failed to create Notification category');
                                        return null;
                                });
                }
                if (!category) return null;
                let channel = guild.channels.cache.find(
                        (ch) => ch.type === ChannelType.GuildText && ch.parentId === category.id && ch.name === 'requests'
                );
                if (!channel) {
                        channel = await guild.channels
                                .create({
                                        name: 'requests',
                                        type: ChannelType.GuildText,
                                        parent: category.id,
                                        reason: 'Invitations anonymes'
                                })
                                .catch((err) => {
                                        this.logger?.warn?.({ err, guildId: guild.id }, 'Failed to create requests channel');
                                        return null;
                                });
                }
                if (channel) {
                        try {
                                await this.db.query(
                                        'INSERT INTO settings (guild_id, requests_channel_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE requests_channel_id = VALUES(requests_channel_id)',
                                        [guild.id, channel.id]
                                );
                                this._guildSettings.set(String(guild.id), {
                                        ...(await this.#getGuildSettings(guild.id)),
                                        requestsChannelId: channel.id,
                                        cachedAt: Date.now()
                                });
                        } catch (err) {
                                this.logger?.warn?.({ err, guildId: guild.id }, 'Failed to persist requests channel');
                        }
                }
                return channel;
        }

        async #getTempGroupMembers(groupId) {
                try {
                        const [rows] = await this.db.query(
                                'SELECT user_id, role FROM temp_group_members WHERE temp_group_id = ?',
                                [groupId]
                        );
                        const members = [];
                        const spectators = [];
                        for (const row of rows || []) {
                                const id = String(row.user_id);
                                if (row.role === 'spectator') {
                                        spectators.push(id);
                                } else {
                                        members.push(id);
                                }
                        }
                        return { members, spectators };
                } catch (err) {
                        this.logger?.warn?.({ err, groupId }, 'Failed to fetch temp group members');
                        return { members: [], spectators: [] };
                }
        }

        async #buildAnonOptions(guildId, zoneId, requesterId) {
                const guild = await this.#fetchGuild(guildId);
                if (!guild) return [];
                const map = await this.getTodayAnonMap(guildId, zoneId);
                const results = [];
                for (const [userId, info] of map) {
                        if (String(userId) === String(requesterId)) continue;
                        let member = null;
                        try {
                                member = await guild.members.fetch({ user: userId, force: false });
                        } catch {}
                        if (!member) continue;
                        results.push({
                                userId: String(userId),
                                label: info?.name || this.#buildAnonName(userId, zoneId),
                                description: info?.count ? `${info.count} message(s) aujourd’hui` : 'Actif aujourd’hui'
                        });
                }
                results.sort((a, b) => (b.description || '').localeCompare(a.description || ''));
                return results.slice(0, 25);
        }

        async getTodayAnonMap(guildId, zoneId) {
                const map = new Map();
                if (!guildId) return map;
                try {
                        const [rows] = await this.db.query(
                                `SELECT user_id, count
                                FROM anon_daily_counts
                                WHERE guild_id = ? AND day = CURRENT_DATE()
                                ORDER BY count DESC, user_id ASC
                                LIMIT 200`,
                                [guildId]
                        );
                        for (const row of rows || []) {
                                const userId = String(row.user_id);
                                map.set(userId, {
                                        name: this.#buildAnonName(userId, zoneId),
                                        count: Number(row.count || 0)
                                });
                        }
                } catch (err) {
                        this.logger?.warn?.({ err, guildId }, 'Failed to load anon map');
                }
                return map;
        }

        async #handleSuggestionDisable(interaction) {
                if (!interaction?.message) return;
                try {
                        await interaction.message.edit({ components: [this.#buildSuggestionButtons({ disabled: true })] });
                } catch {}
        }

        async handleFromAnonCreateClosed(interaction) {
                const context = this.#getSuggestionContext(interaction.message);
                if (!context || String(context.userId) !== String(interaction.user.id)) {
                        const payload = {
                                content: 'Action réservée à la personne concernée.',
                                flags: MessageFlags.Ephemeral
                        };
                        if (interaction.deferred || interaction.replied) {
                                return interaction.followUp(payload);
                        }
                        return interaction.reply(payload);
                }
                await this.#handleSuggestionDisable(interaction);
                const options = await this.#buildAnonOptions(context.guildId, context.zoneId, context.userId);
                if (!options.length) {
                        const payload = {
                                content: 'Aucun autre pseudonyme disponible aujourd’hui.',
                                flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined
                        };
                        if (interaction.deferred || interaction.replied) {
                                return interaction.followUp(payload);
                        }
                        return interaction.reply(payload);
                }
                const select = new StringSelectMenuBuilder()
                        .setCustomId('temp:fromAnon:closed:select')
                        .setPlaceholder('Choisis les anonymes à inviter')
                        .setMinValues(1)
                        .setMaxValues(Math.min(25, options.length));
                for (const option of options) {
                        select.addOptions({ label: option.label, value: option.userId, description: option.description });
                }
                const row = new ActionRowBuilder().addComponents(select);
                const payload = {
                        content: 'Sélectionne les anonymes que tu souhaites inviter (multi-sélection).',
                        components: [row]
                };
                if (interaction.inGuild()) {
                        payload.flags = MessageFlags.Ephemeral;
                }
                if (interaction.deferred || interaction.replied) {
                        await interaction.followUp(payload);
                } else {
                        await interaction.reply(payload);
                }
                const replyMessage = await interaction.fetchReply().catch(() => null);
                if (replyMessage) {
                        this.#storeSuggestionContext(replyMessage.id, {
                                ...context,
                                type: 'closed-select',
                                originMessageId: context.messageId || interaction.message.id
                        });
                }
        }

        async #notifyFallbackInvites(guild, zoneId, textChannelId, failedIds = []) {
                if (!failedIds.length) return;
                const settings = await this.#getGuildSettings(guild?.id);
                const channel = await this.#ensureRequestsChannel(guild, settings);
                if (!channel) return;
                const names = failedIds.map((id) => `• ${this.#buildAnonName(id, zoneId)}`);
                const url = textChannelId ? `https://discord.com/channels/${guild.id}/${textChannelId}` : null;
                const content = [
                        '🔔 Invitation anonyme disponible :',
                        names.join('\n'),
                        textChannelId ? `Rejoignez le salon temporaire : <#${textChannelId}>${url ? ` (${url})` : ''}.` : null
                ]
                        .filter(Boolean)
                        .join('\n');
                await channel.send({ content, allowedMentions: { parse: [] } }).catch((err) => {
                        this.logger?.warn?.({ err, channelId: channel.id }, 'Failed to send fallback anon invite');
                });
        }

        async #dmInvite(userId, payload) {
                try {
                        const user = await this.client.users.fetch(userId);
                        await user.send(payload);
                        return true;
                } catch {
                        return false;
                }
        }

        async handleFromAnonClosedSelect(interaction) {
                const context = this.#getSuggestionContext(interaction.message);
                if (!context || String(context.userId) !== String(interaction.user.id)) {
                        if (!interaction.deferred && !interaction.replied) {
                                await interaction.reply({
                                        content: 'Sélection expirée ou non autorisée.',
                                        flags: MessageFlags.Ephemeral
                                });
                        }
                        return;
                }
                const selected = Array.from(new Set((interaction.values || []).map((val) => String(val)).filter(Boolean)));
                if (!selected.length) {
                        if (!interaction.deferred && !interaction.replied) {
                                await interaction.reply({
                                        content: 'Aucun participant sélectionné.',
                                        flags: MessageFlags.Ephemeral
                                });
                        }
                        return;
                }
                await interaction.deferUpdate();
                const guild = await this.#fetchGuild(context.guildId);
                const tempGroupService = this.client?.context?.services?.tempGroup || null;
                if (!guild || !tempGroupService?.createTempGroup) {
                        await interaction.editReply({
                                content: 'Impossible de créer le groupe pour le moment.',
                                components: []
                        });
                        return;
                }
                const participants = Array.from(new Set([String(context.userId), ...selected]));
                let creation = null;
                try {
                        creation = await tempGroupService.createTempGroup(guild, {
                                name: 'temp-closed',
                                isOpen: false,
                                participants,
                                createdBy: context.userId
                        });
                } catch (err) {
                        this.logger?.error?.({ err }, 'Failed to create closed temp group');
                        await interaction.editReply({
                                content: 'Erreur lors de la création du groupe.',
                                components: []
                        });
                        return;
                }
                const textChannelId = creation?.textChannelId;
                const link = textChannelId ? `https://discord.com/channels/${guild.id}/${textChannelId}` : null;
                const dmPayload = {
                        content: [
                                '👋 Une discussion temporaire privée t’attend.',
                                textChannelId ? `Accède au salon : <#${textChannelId}>` : null,
                                link ? `Lien direct : ${link}` : null,
                                'Ce salon reste anonyme pour tout le monde.'
                        ]
                                .filter(Boolean)
                                .join('\n'),
                        allowedMentions: { parse: [] }
                };
                const failed = [];
                for (const userId of selected) {
                        const ok = await this.#dmInvite(userId, dmPayload);
                        if (!ok) failed.push(userId);
                }
                if (failed.length) {
                        await this.#notifyFallbackInvites(guild, context.zoneId, textChannelId, failed);
                }
                await tempGroupService.updatePanel?.(creation?.groupId).catch(() => {});
                const requesterName = context.requesterAnon || this.#buildAnonName(context.userId, context.zoneId);
                await interaction.editReply({
                        content: `✅ Salon fermé créé (${requesterName}). Rendez-vous dans ${textChannelId ? `<#${textChannelId}>` : 'le nouveau groupe'}.`,
                        components: []
                });
                this.#removeSuggestionContext(interaction.message);
                if (context.originMessageId) {
                        this.#removeSuggestionContext(context.originMessageId);
                }
        }

        #buildOpenButtons(groupId) {
                return new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                                .setCustomId(`temp:open:join:${groupId}`)
                                .setLabel('Rejoindre')
                                .setStyle(ButtonStyle.Success),
                        new ButtonBuilder()
                                .setCustomId(`temp:open:spectate:${groupId}`)
                                .setLabel('Observer')
                                .setStyle(ButtonStyle.Secondary)
                );
        }

        async #buildOpenEmbed(context, members, spectators) {
                const map = await this.getTodayAnonMap(context.guildId, context.zoneId);
                const nameFor = (id) => map.get(id)?.name || this.#buildAnonName(id, context.zoneId);
                const memberNames = members.length ? members.map((id) => `• ${nameFor(id)}`) : ['Personne pour le moment.'];
                const spectatorNames = spectators.length ? spectators.map((id) => `• ${nameFor(id)}`) : ['Aucun spectateur.'];
                const embed = new EmbedBuilder()
                        .setColor(context.zoneColor || 0x5865f2)
                        .setTitle(context.zoneName ? `Temp zone anonyme – ${context.zoneName}` : 'Temp zone anonyme')
                        .setDescription(
                                `Un salon temporaire ouvert vient d’être créé par ${context.requesterAnon}. ` +
                                        'Rejoignez-le en restant anonyme.'
                        )
                        .addFields(
                                { name: 'Participants', value: memberNames.join('\n') },
                                { name: 'Observateurs', value: spectatorNames.join('\n') }
                        )
                        .setFooter({ text: 'Pseudos anonymes valables uniquement aujourd’hui.' })
                        .setTimestamp(new Date());
                return embed;
        }

        #registerOpenPanel(groupId, payload) {
                if (!groupId || !payload) return;
                this._openPanels.set(Number(groupId), { ...payload, groupId: Number(groupId) });
        }

        async #refreshOpenPanel(groupId) {
                const context = this._openPanels.get(Number(groupId));
                if (!context) return;
                const channel = await this.client.channels.fetch(context.channelId).catch(() => null);
                if (!channel) {
                        this._openPanels.delete(Number(groupId));
                        return;
                }
                const message = await channel.messages.fetch(context.messageId).catch(() => null);
                if (!message) {
                        this._openPanels.delete(Number(groupId));
                        return;
                }
                const { members, spectators } = await this.#getTempGroupMembers(groupId);
                const embed = await this.#buildOpenEmbed(context, members, spectators);
                const row = this.#buildOpenButtons(groupId);
                await message.edit({ embeds: [embed], components: [row] }).catch(() => {});
        }

        async handleFromAnonCreateOpen(interaction) {
                const context = this.#getSuggestionContext(interaction.message);
                if (!context || String(context.userId) !== String(interaction.user.id)) {
                        const payload = {
                                content: 'Action réservée à la personne concernée.',
                                flags: MessageFlags.Ephemeral
                        };
                        if (interaction.deferred || interaction.replied) {
                                return interaction.followUp(payload);
                        }
                        return interaction.reply(payload);
                }
                await this.#handleSuggestionDisable(interaction);
                const guild = await this.#fetchGuild(context.guildId);
                const tempGroupService = this.client?.context?.services?.tempGroup || null;
                if (!guild || !tempGroupService?.createTempGroup) {
                        const payload = {
                                content: 'Service indisponible pour le moment.',
                                flags: MessageFlags.Ephemeral
                        };
                        if (interaction.deferred || interaction.replied) {
                                return interaction.followUp(payload);
                        }
                        return interaction.reply(payload);
                }
                const anonChannel = await this.client.channels.fetch(context.channelId).catch(() => null);
                if (!anonChannel || !('send' in anonChannel)) {
                        const payload = {
                                content: 'Salon anonyme introuvable pour annoncer le groupe.',
                                flags: MessageFlags.Ephemeral
                        };
                        if (interaction.deferred || interaction.replied) {
                                return interaction.followUp(payload);
                        }
                        return interaction.reply(payload);
                }
                let creation = null;
                try {
                        creation = await tempGroupService.createTempGroup(guild, {
                                name: 'temp-open',
                                isOpen: true,
                                participants: [String(context.userId)],
                                spectators: [],
                                createdBy: context.userId
                        });
                } catch (err) {
                        this.logger?.error?.({ err }, 'Failed to create open temp group');
                        const payload = {
                                content: 'Impossible de créer le groupe ouvert.',
                                flags: MessageFlags.Ephemeral
                        };
                        if (interaction.deferred || interaction.replied) {
                                return interaction.followUp(payload);
                        }
                        return interaction.reply(payload);
                }
                await tempGroupService.updatePanel?.(creation?.groupId).catch(() => {});
                const embed = await this.#buildOpenEmbed(context, [String(context.userId)], []);
                const row = this.#buildOpenButtons(creation.groupId);
                const message = await anonChannel
                        .send({ embeds: [embed], components: [row] })
                        .catch((err) => {
                                this.logger?.warn?.({ err, channelId: context.channelId }, 'Failed to post open temp panel');
                                return null;
                        });
                if (message) {
                        this.#registerOpenPanel(creation.groupId, {
                                messageId: message.id,
                                channelId: message.channelId,
                                guildId: context.guildId,
                                zoneId: context.zoneId,
                                zoneName: context.zoneName,
                                zoneColor: context.zoneColor,
                                requesterAnon: context.requesterAnon
                        });
                }
                const ack = {
                        content: message
                                ? '✅ Salon ouvert créé et annoncé.'
                                : 'Salon créé, mais impossible de publier l’annonce.',
                        flags: interaction.inGuild() ? MessageFlags.Ephemeral : undefined
                };
                if (interaction.deferred || interaction.replied) {
                        await interaction.followUp(ack);
                } else {
                        await interaction.reply(ack);
                }
                this.#removeSuggestionContext(interaction.message);
        }

        async handleOpenJoin(interaction, groupId) {
                const tempGroupService = this.client?.context?.services?.tempGroup || null;
                if (!tempGroupService?.joinGroup) {
                        const payload = {
                                content: 'Service indisponible.',
                                flags: MessageFlags.Ephemeral
                        };
                        if (interaction.deferred || interaction.replied) {
                                return interaction.followUp(payload);
                        }
                        return interaction.reply(payload);
                }
                const result = await tempGroupService.joinGroup(groupId, interaction.user.id);
                const payload = {
                        content: result?.message || (result?.ok ? 'Inscription enregistrée.' : 'Action impossible.'),
                        flags: MessageFlags.Ephemeral
                };
                if (interaction.deferred || interaction.replied) {
                        await interaction.followUp(payload);
                } else {
                        await interaction.reply(payload);
                }
                if (result?.ok) {
                        await this.#refreshOpenPanel(groupId);
                        await tempGroupService.updatePanel?.(groupId).catch(() => {});
                }
        }

        async handleOpenSpectate(interaction, groupId) {
                const tempGroupService = this.client?.context?.services?.tempGroup || null;
                if (!tempGroupService?.spectateGroup) {
                        const payload = {
                                content: 'Service indisponible.',
                                flags: MessageFlags.Ephemeral
                        };
                        if (interaction.deferred || interaction.replied) {
                                return interaction.followUp(payload);
                        }
                        return interaction.reply(payload);
                }
                const result = await tempGroupService.spectateGroup(groupId, interaction.user.id);
                const payload = {
                        content: result?.message || (result?.ok ? 'Observation activée.' : 'Action impossible.'),
                        flags: MessageFlags.Ephemeral
                };
                if (interaction.deferred || interaction.replied) {
                        await interaction.followUp(payload);
                } else {
                        await interaction.reply(payload);
                }
                if (result?.ok) {
                        await this.#refreshOpenPanel(groupId);
                        await tempGroupService.updatePanel?.(groupId).catch(() => {});
                }
        }

	#todaySalt() {
		const d = new Date();
		const key = `${d.getUTCFullYear()}-${d.getUTCMonth()+1}-${d.getUTCDate()}`;
		return crypto.createHash('sha256').update('daily-salt::' + key).digest('hex').slice(0, 16);
	}

    #buildAnonName(userId, targetZoneId) {
        const seed = `${userId}:${targetZoneId}:${this.#todaySalt()}`;
        return generateAnonName(seed);
    }

	async #getZone(zoneId) {
	const [rows] = await this.db.query(
	'SELECT id, name, guild_id, role_owner_id, role_member_id FROM zones WHERE id = ?',
	[zoneId]
	);
	return rows?.[0] || null;
	}

	async #resolveZoneColor(zoneRow) {
	if (!zoneRow) return 0x5865f2;
	try {
	const guild = await this.client.guilds.fetch(zoneRow.guild_id);
	if (zoneRow.role_owner_id) {
	const ownerRole = await guild.roles.fetch(zoneRow.role_owner_id).catch(() => null);
	if (ownerRole?.color) return ownerRole.color;
	}
	if (zoneRow.role_member_id) {
	const memberRole = await guild.roles.fetch(zoneRow.role_member_id).catch(() => null);
	if (memberRole?.color) return memberRole.color;
	}
	} catch {}
	return 0x5865f2;
	}

	async #getAnonAdminChannelId(guildId) {
		const [rows] = await this.db.query('SELECT anon_admin_channel_id FROM settings WHERE guild_id = ?', [guildId]);
		return rows?.[0]?.anon_admin_channel_id || process.env.ANON_ADMIN_CHANNEL_ID || null;
	}

	async #findZoneByAnonChannel(channelId) {
		const [rows] = await this.db.query('SELECT zone_id FROM anon_channels WHERE source_channel_id = ?', [channelId]);
		return rows?.[0]?.zone_id || null;
	}

        async #allTargets() {
                const [rows] = await this.db.query('SELECT zone_id, source_channel_id, webhook_id, webhook_token FROM anon_channels');
                return rows;
        }

        async #ensureWebhook(row) {
                if (!row) return row;
                if (row.webhook_id === '0' || row.webhook_token === '0') {
                        row._webhookDisabled = true;
                        return row;
                }
                if (row.webhook_id && row.webhook_token) return row;

                const channel = await this.client.channels.fetch(row.source_channel_id).catch(() => null);
                if (!channel) return row;

                try {
                        const hook = await channel.createWebhook({ name: 'Anon Relay' });
                        await this.db.query('UPDATE anon_channels SET webhook_id=?, webhook_token=? WHERE zone_id=?', [hook.id, hook.token, row.zone_id]);
                        row.webhook_id = hook.id;
                        row.webhook_token = hook.token;
                } catch (err) {
                        if (err?.code === 50013 || err?.status === 403) {
                                this.logger?.warn?.({ err, channelId: row.source_channel_id }, 'Missing Manage Webhooks permission');
                                await this.db.query('UPDATE anon_channels SET webhook_id=?, webhook_token=? WHERE zone_id=?', ['0', '0', row.zone_id]).catch(() => {});
                                row.webhook_id = '0';
                                row.webhook_token = '0';
                                row._webhookDisabled = true;
                        } else {
                                this.logger?.error?.({ err, channelId: row.source_channel_id }, 'Failed to ensure anon webhook');
                        }
                }

                return row;
        }

	#sanitize(content) {
		if (!content) return '';
		return content
			.replace(/@everyone/gi, '@\u200beveryone')
			.replace(/@here/gi, '@\u200bhere');
	}

        async handleMessage(message) {
                if (!message || !message.guild || message.author.bot) return;

                const zoneId = await this.#findZoneByAnonChannel(message.channelId);
                if (!zoneId) return; // not an anon channel

                const zoneRow = await this.#getZone(zoneId);
                const zoneColor = await this.#resolveZoneColor(zoneRow);
                const { threshold } = await this.#getGuildSettings(message.guild.id);
                const count = await this.#incrementDailyCount(message.guild.id, message.author.id);
                await this.#maybeSuggestTempGroup(message, zoneRow, zoneColor, count, threshold);
                const sanitized = this.#sanitize(message.content || '');
                const logContent = sanitized || '(aucun texte)';
                const files = message.attachments?.size
                        ? [...message.attachments.values()].map((a) => a.url)
                        : [];

                await this.db
                        .query(
                                'INSERT INTO anon_logs (guild_id, source_zone_id, author_id, content, created_at) VALUES (?, ?, ?, ?, NOW())',
                                [message.guild.id, zoneId, message.author.id, sanitized]
                        )
                        .catch(() => {});

                // Log raw to admin
                const adminChannelId = await this.#getAnonAdminChannelId(message.guild.id);
                if (adminChannelId) {
                        const adminCh = await this.client.channels.fetch(adminChannelId).catch(() => null);
                        if (adminCh) {
                                const embed = new EmbedBuilder()
                                        .setTitle('Anon log')
                                        .setColor(zoneColor)
                                        .setThumbnail(message.author.displayAvatarURL({ size: 128 }))
                                        .addFields(
                                                { name: 'Zone', value: zoneRow ? `${zoneRow.name} (#${zoneRow.id})` : `Zone ${zoneId}` },
                                                { name: 'Auteur', value: `${message.author.tag} (${message.author.id})` }
                                        )
                                        .setTimestamp(message.createdAt || new Date());
                                if (files.length) {
                                        embed.addFields({ name: 'Pièces jointes', value: `${files.length}` });
                                }
                                await adminCh.send({ content: logContent, allowedMentions: { parse: [] } }).catch(() => {});
                                await adminCh.send({ embeds: [embed], files, allowedMentions: { parse: [] } }).catch(() => {});
                        }
                }

                // Delete original
                await message.delete().catch(() => {});

                // Fan-out
                const targets = await this.#allTargets();

                for (const row of targets) {
                        if (!row || !row.source_channel_id) continue;
                        const hooked = await this.#ensureWebhook(row);
                        if (!hooked || hooked._webhookDisabled) continue;
                        if (!hooked.webhook_id || !hooked.webhook_token) continue;

                        const hook = new WebhookClient({ id: hooked.webhook_id, token: hooked.webhook_token });
                        const name = this.#buildAnonName(message.author.id, row.zone_id);

                        await hook
                                .send({
                                        username: name,
                                        content: sanitized.length ? sanitized : undefined,
                                        files,
                                        allowedMentions: { parse: [] }
                                })
                                .catch((err) => {
                                        this.logger?.warn?.({ err, zoneId: row.zone_id }, 'Failed to relay anonymous message');
                                });
                }
        }

        async presentOptions(interaction, { message = null } = {}) {
                const baseText = [
                        '📣 Les messages envoyés dans ce salon sont relayés anonymement aux zones participantes.',
                        '🚨 Les abus sont consignés et peuvent entraîner des sanctions.'
                ];

                if (message?.url) {
                        baseText.push(`Message ciblé : ${message.url}`);
                }

                const payload = {
                        content: baseText.join('\n'),
                        flags: MessageFlags.Ephemeral
                };

                if (interaction.deferred || interaction.replied) {
                        return interaction.followUp(payload);
                }

                return interaction.reply(payload);
        }
}

module.exports = { AnonService };
