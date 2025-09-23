module.exports = {
        name: 'guildMemberRemove',
        once: false,
        async execute(member, client) {
                const pool = client?.context?.pool;
                const logger = client?.context?.logger;
                const panelService = client?.context?.services?.panel;

                if (!pool || !member?.guild) {
                        return;
                }

                const guildId = member.guild.id;
                const userId = member.id;

                try {
                        const [zoneRows] = await pool.query(
                                `SELECT DISTINCT z.id
                                 FROM zones z
                                 LEFT JOIN zone_member_roles zmr ON zmr.zone_id = z.id AND zmr.user_id = ?
                                 LEFT JOIN zone_members zm ON zm.zone_id = z.id AND zm.user_id = ?
                                 WHERE z.guild_id = ? AND (zmr.user_id IS NOT NULL OR zm.user_id IS NOT NULL)`,
                                [userId, userId, guildId]
                        );

                        await pool.query(
                                `DELETE zmr FROM zone_member_roles zmr
                                 INNER JOIN zones z ON z.id = zmr.zone_id
                                 WHERE z.guild_id = ? AND zmr.user_id = ?`,
                                [guildId, userId]
                        );

                        await pool.query(
                                `DELETE zm FROM zone_members zm
                                 INNER JOIN zones z ON z.id = zm.zone_id
                                 WHERE z.guild_id = ? AND zm.user_id = ?`,
                                [guildId, userId]
                        );

                        if (panelService && Array.isArray(zoneRows) && zoneRows.length) {
                                for (const row of zoneRows) {
                                        await panelService.refresh(row.id, ['members']).catch(() => { });
                                }
                        }
                } catch (err) {
                        logger?.warn({ err, guildId, userId }, 'Failed to clean zone membership after member departure');
                }
        }
};
