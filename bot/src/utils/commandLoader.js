
const fs = require('fs');
const path = require('path');

/**
 * Load slash & context commands recursively.
 * Each module must export:
 *  - data (SlashCommandBuilder | ContextMenuCommandBuilder)
 *  - execute(interaction, ctx)
 *  - (optional) ownerOnly = true
 */
async function loadCommands(rootDir) {
	const commands = new Map();
	const context = new Map();

	function walk(dir) {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(p);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith('.js')) continue;

			const mod = require(p);
			if (!mod || !mod.data || typeof mod.execute !== 'function') continue;
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
	return { commands, context };
}

module.exports = { loadCommands };
