const fs = require('node:fs');
const path = require('node:path');
const {
	SlashCommandBuilder,
	SlashCommandSubcommandBuilder,
	SlashCommandSubcommandGroupBuilder,
	ContextMenuCommandBuilder,
	ApplicationCommandType
} = require('discord.js');

function traverse(dir) {
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...traverse(full));
		} else if (entry.name.endsWith('.js')) {
			files.push(full);
		}
	}
	return files;
}

function makeKey(group, sub) {
	return `${group || ''}:${sub}`;
}

function loadSlashCommands(baseDir, logger) {
	const files = traverse(baseDir);
	const raw = new Map();

	for (const file of files) {
		// eslint-disable-next-line global-require, import/no-dynamic-require
		const fragment = require(file);
		if (fragment?.data?.toJSON?.()?.type === ApplicationCommandType.Message) {
			throw new Error(`Context menu located in commands directory: ${file}`);
		}
		const commandName = fragment.command || fragment.data?.name;
		if (!commandName) {
			logger?.warn({ file }, 'Skipping command fragment without command name');
			continue;
		}
		const sub = fragment.subCommand || fragment.subcommand || fragment.subCommandName;
		const group = fragment.subCommandGroup || fragment.group || null;
		if (!sub && fragment.execute) {
			logger?.warn({ file }, 'Missing subcommand name');
			continue;
		}
		if (!raw.has(commandName)) {
			raw.set(commandName, []);
		}
		raw.get(commandName).push({ group, sub, fragment });
	}

	const commands = new Map();

	for (const [name, fragments] of raw.entries()) {
		const entry = {
			data: new SlashCommandBuilder().setName(name).setDescription('Secure zone controls'),
			fragments: new Map()
		};
		const grouped = new Map();
		for (const item of fragments) {
			const { group, sub, fragment } = item;
			if (fragment.rootDescription) {
				entry.data.setDescription(fragment.rootDescription);
			}
			entry.fragments.set(makeKey(group, sub), fragment);
			if (group) {
				if (!grouped.has(group)) {
					grouped.set(group, []);
				}
				grouped.get(group).push(fragment);
			} else {
				entry.data.addSubcommand((subBuilder) => {
					const builder = new SlashCommandSubcommandBuilder().setName(sub).setDescription(fragment.description || 'Action');
					if (typeof fragment.build === 'function') {
						fragment.build(builder);
					}
					Object.assign(subBuilder, builder);
					return subBuilder;
				});
			}
		}
		for (const [groupName, groupFragments] of grouped.entries()) {
			entry.data.addSubcommandGroup((groupBuilder) => {
				const base = new SlashCommandSubcommandGroupBuilder().setName(groupName).setDescription(groupFragments[0].groupDescription || `${groupName} tools`);
				Object.assign(groupBuilder, base);
				for (const fragment of groupFragments) {
					groupBuilder.addSubcommand((subBuilder) => {
						const builder = new SlashCommandSubcommandBuilder().setName(fragment.subCommand || fragment.subcommand).setDescription(fragment.description || 'Action');
						if (typeof fragment.build === 'function') {
							fragment.build(builder);
						}
						Object.assign(subBuilder, builder);
						return subBuilder;
					});
				}
				return groupBuilder;
			});
		}
		commands.set(name, entry);
	}

	return commands;
}

function loadContextMenus(baseDir) {
	if (!fs.existsSync(baseDir)) {
		return new Map();
	}
	const files = traverse(baseDir);
	const contexts = new Map();
	for (const file of files) {
		// eslint-disable-next-line global-require, import/no-dynamic-require
		const ctx = require(file);
		if (!(ctx.data instanceof ContextMenuCommandBuilder)) {
			throw new Error(`Context command must export ContextMenuCommandBuilder: ${file}`);
		}
		contexts.set(ctx.data.name, ctx);
	}
	return contexts;
}

module.exports = {
	loadSlashCommands,
	loadContextMenus,
	makeKey
};
