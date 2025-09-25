
const fs = require('fs');
const path = require('path');
const { SlashCommandBuilder } = require('discord.js');

function normalizeDescription(text, fallback) {
        if (typeof text === 'string' && text.trim().length) return text.trim().slice(0, 100);
        return fallback;
}

function buildLegacySlashCommand(commandName, bucket) {
        const builder = new SlashCommandBuilder()
                .setName(commandName)
                .setDescription(normalizeDescription(bucket.rootDescription, `Command ${commandName}`));

        if (typeof bucket.dmPermission === 'boolean') {
                builder.setDMPermission(bucket.dmPermission);
        }
        if (bucket.defaultMemberPermissions) {
                builder.setDefaultMemberPermissions(bucket.defaultMemberPermissions);
        }

        const handlers = new Map();

        const singles = bucket.modules.filter((mod) => !mod.subCommandGroup);
        const grouped = bucket.modules.filter((mod) => mod.subCommandGroup);

        for (const mod of singles) {
                if (!mod.subCommand) continue;
                builder.addSubcommand((sub) => {
                        sub.setName(mod.subCommand);
                        sub.setDescription(normalizeDescription(mod.description, mod.subCommand));
                        if (typeof mod.build === 'function') {
                                mod.build(sub);
                        }
                        return sub;
                });
                handlers.set(`:${mod.subCommand}`, mod);
        }

        const groups = new Map();
        for (const mod of grouped) {
                const groupName = mod.subCommandGroup;
                if (!groups.has(groupName)) {
                        groups.set(groupName, {
                                description: normalizeDescription(
                                        mod.subCommandGroupDescription,
                                        `Actions ${groupName}`
                                ),
                                modules: []
                        });
                }
                groups.get(groupName).modules.push(mod);
        }

        for (const [groupName, meta] of groups) {
                builder.addSubcommandGroup((group) => {
                        group.setName(groupName);
                        group.setDescription(meta.description || `Actions ${groupName}`);
                        for (const mod of meta.modules) {
                                if (!mod.subCommand) continue;
                                group.addSubcommand((sub) => {
                                        sub.setName(mod.subCommand);
                                        sub.setDescription(normalizeDescription(mod.description, mod.subCommand));
                                        if (typeof mod.build === 'function') {
                                                mod.build(sub);
                                        }
                                        return sub;
                                });
                                handlers.set(`${groupName}:${mod.subCommand}`, mod);
                        }
                        return group;
                });
        }

        return {
                data: builder,
                async execute(interaction, ctx) {
                        const group = interaction.options.getSubcommandGroup(false) || '';
                        const sub = interaction.options.getSubcommand(true);
                        const key = `${group}:${sub}`;
                        const mod = handlers.get(key);
                        if (!mod || typeof mod.execute !== 'function') {
                                throw new Error(`No handler registered for ${commandName}:${key}`);
                        }

                        const ownerId =
                                ctx?.config?.ownerUserId || process.env.OWNER_ID || process.env.OWNER_USER_ID || null;
                        if (mod.globalOwnerOnly || mod.ownerOnly) {
                                if (!ownerId || interaction.user.id !== String(ownerId)) {
                                        return interaction.reply({
                                                content: 'Commande réservée à l’Owner.',
                                                ephemeral: true
                                        });
                                }
                        }

                        return mod.execute(interaction, ctx);
                }
        };
}

/**
 * Load slash & context commands recursively.
 * Supports legacy modules exporting `{ command, subCommand, build, execute }` by regrouping them
 * under a dynamic SlashCommandBuilder.
 */
async function loadCommands(rootDir) {
        const commands = new Map();
        const context = new Map();
        const legacy = new Map();

        function registerLegacy(mod) {
                if (!mod.command || !mod.subCommand || typeof mod.execute !== 'function') return false;

                const entry = legacy.get(mod.command) || {
                        modules: [],
                        rootDescription: mod.rootDescription || null,
                        defaultMemberPermissions: mod.rootDefaultMemberPermissions || null,
                        dmPermission: typeof mod.rootDmPermission === 'boolean' ? mod.rootDmPermission : undefined
                };

                if (!entry.rootDescription && mod.rootDescription) {
                        entry.rootDescription = mod.rootDescription;
                }
                if (!entry.defaultMemberPermissions && mod.rootDefaultMemberPermissions) {
                        entry.defaultMemberPermissions = mod.rootDefaultMemberPermissions;
                }
                if (typeof mod.rootDmPermission === 'boolean') {
                        entry.dmPermission = mod.rootDmPermission;
                }

                entry.modules.push(mod);
                legacy.set(mod.command, entry);
                return true;
        }

        function walk(dir) {
                for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                        const p = path.join(dir, entry.name);
                        if (entry.isDirectory()) {
                                walk(p);
                                continue;
                        }
                        if (!entry.isFile() || !entry.name.endsWith('.js')) continue;

                        const mod = require(p);
                        if (!mod) continue;

                        const hasLegacy = registerLegacy(mod);
                        if (hasLegacy) continue;

                        if (!mod.data || typeof mod.execute !== 'function') continue;
                        const name = mod.data?.name;
                        if (!name) continue;

                        const ctorName = mod.data?.constructor?.name || '';
                        if (ctorName.includes('ContextMenu')) {
                                context.set(name, mod);
                        } else {
                                commands.set(name, mod);
                        }
                }
        }

        if (fs.existsSync(rootDir)) walk(rootDir);

        for (const [commandName, bucket] of legacy) {
                if (!bucket.modules.length) continue;
                const built = buildLegacySlashCommand(commandName, bucket);
                commands.set(commandName, built);
        }

        return { commands, context };
}

module.exports = { loadCommands };
