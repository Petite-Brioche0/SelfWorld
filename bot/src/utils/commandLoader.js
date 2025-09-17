
const fs = require('fs');
const path = require('path');

/**
 * Recursively load slash commands and context menu handlers.
 * Each command must export:
 *  - data (SlashCommandBuilder | ContextMenuCommandBuilder)
 *  - execute(interaction, ctx)
 */
async function loadCommands(rootDir) {
	const commands = new Map();
	const context = new Map();

	function walk(dir) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(p);
			} else if (entry.isFile() && entry.name.endsWith('.js')) {
				const mod = require(p);
				if (!mod) continue;
				if (mod.data && typeof mod.execute === 'function') {
					const typeName = (mod.data?.constructor?.name) || '';
					const name = mod.data.name;
					if (!name) continue;
					if (typeName.includes('ContextMenu')) {
						context.set(name, mod);
					} else {
						commands.set(name, mod);
					}
				}
			}
		}
	}
	if (fs.existsSync(rootDir)) walk(rootDir);
	return { commands, context };
}

module.exports = { loadCommands };
