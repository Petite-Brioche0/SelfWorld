'use strict';

/**
 * Creates a mock Discord interaction for testing.
 * @param {object} opts
 * @param {string} [opts.customId]
 * @param {string} [opts.userId]
 * @param {object} [opts.fields] - map of fieldId → value for modal interactions
 */
function mockInteraction(opts = {}) {
	const interaction = {
		customId: opts.customId || '',
		user: { id: opts.userId || '123456789012345678' },
		guild: opts.guild || { id: '999999999999999999' },
		guildId: opts.guildId || '999999999999999999',
		values: opts.values || [],
		deferred: false,
		replied: false,
		message: { edit: vi.fn().mockResolvedValue(undefined) },
		fields: {
			getTextInputValue: (key) => (opts.fields || {})[key] ?? '',
		},
		reply: vi.fn(async () => { interaction.replied = true; }),
		editReply: vi.fn().mockResolvedValue(undefined),
		followUp: vi.fn().mockResolvedValue(undefined),
		deferReply: vi.fn(async () => { interaction.deferred = true; }),
		deferUpdate: vi.fn(async () => { interaction.deferred = true; }),
		update: vi.fn().mockResolvedValue(undefined),
		showModal: vi.fn().mockResolvedValue(undefined),
	};
	return interaction;
}

module.exports = { mockInteraction };
