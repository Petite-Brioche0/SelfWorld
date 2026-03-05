'use strict';

const { vi } = require('vitest');

/**
 * Creates a minimal Discord.js Client mock.
 */
function mockClient(opts = {}) {
	return {
		user: { id: opts.botId || '111111111111111111' },
		guilds: {
			cache: opts.guilds || new Map(),
			fetch: vi.fn().mockResolvedValue(null),
		},
		channels: {
			fetch: vi.fn().mockResolvedValue(null),
		},
		users: {
			fetch: vi.fn().mockResolvedValue({ send: vi.fn().mockResolvedValue(undefined) }),
		},
		members: {
			me: null,
		},
		context: opts.context || null,
	};
}

module.exports = { mockClient };
