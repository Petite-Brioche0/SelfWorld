
require('dotenv').config();
const path = require('node:path');
const { REST, Routes } = require('discord.js');
const pino = require('pino');
const { loadCommands } = require('./utils/commandLoader');

const logger = pino({
	level: process.env.LOG_LEVEL || 'info',
	transport: process.env.NODE_ENV !== 'production'
		? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:standard' } }
		: undefined
});

if (!process.env.CLIENT_ID || !process.env.GUILD_ID || !process.env.DISCORD_TOKEN) {
	logger.error('Missing CLIENT_ID, GUILD_ID or DISCORD_TOKEN');
	process.exit(1);
}

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
	try {
		const { commands, context } = await loadCommands(path.join(__dirname, 'commands'));
		const payload = [
			...Array.from(commands.values()).map((entry) => entry.data.toJSON()),
			...Array.from(context.values()).map((entry) => entry.data.toJSON())
		];

		logger.info(`Deploying ${payload.length} commands to guild ${process.env.GUILD_ID}`);

		await rest.put(
			Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
			{ body: payload }
		);

		logger.info('Commands deployed successfully');
	} catch (error) {
		logger.error({ err: error }, 'Failed to deploy commands');
		process.exitCode = 1;
	}
})();
