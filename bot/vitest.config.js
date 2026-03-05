/** @type {import('vitest/config').UserConfig} */
module.exports = {
	test: {
		globals: true,
		environment: 'node',
		include: ['tests/**/*.test.js'],
	},
};
