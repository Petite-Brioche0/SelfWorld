
const fs = require('fs');
const path = require('path');

/**
 * Recursively load commands and context menu handlers.
 * Each command module must export:
 *   - data (SlashCommandBuilder | ContextMenuCommandBuilder)
 *   - execute(interaction, deps)
 * Optional:
 *   - guildOnly (boolean)
 *   - ownerOnly (boolean)  // admin absolu (Owner)
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
				if (!mod || !mod.data || !mod.execute) continue;
				const name = mod.data.name;
				if (!name) continue;

				// Detect context menu by builder type name
				const typeName = (mod.data.constructor && mod.data.constructor.name) || '';
				if (typeName.includes('ContextMenu')) {
					context.set(name, mod);
				} else {
					commands.set(name, mod);
				}
			}
		}
	}

	walk(rootDir);
	return { commands, context };
}

module.exports = { loadCommands };
