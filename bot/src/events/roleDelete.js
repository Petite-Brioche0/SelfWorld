module.exports = {
	name: 'roleDelete',
	once: false,
	async execute(role, client) {
		const { logger, services } = client.context;
		try {
			await services.repair?.handleRoleDelete?.(role);
		} catch (err) {
			logger.warn({ err, roleId: role?.id }, 'roleDelete handler failed');
		}
	}
};
