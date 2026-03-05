'use strict';

const { ActivityService } = require('../../src/services/ActivityService');
const { mockDb } = require('../helpers/mockDb');

describe('ActivityService.buildProgressBar', () => {
	const service = new ActivityService(null, null);

	it('returns 10 empty segments for score 0', () => {
		expect(service.buildProgressBar(0)).toBe('▱▱▱▱▱▱▱▱▱▱');
	});

	it('returns 10 filled segments for score 1', () => {
		expect(service.buildProgressBar(1)).toBe('▰▰▰▰▰▰▰▰▰▰');
	});

	it('returns 5 filled for score 0.5', () => {
		expect(service.buildProgressBar(0.5)).toBe('▰▰▰▰▰▱▱▱▱▱');
	});

	it('always returns 10 characters total', () => {
		for (const score of [0, 0.1, 0.33, 0.5, 0.75, 0.9, 1]) {
			const bar = service.buildProgressBar(score);
			expect(bar.replace(/[▰▱]/g, 'x').length).toBe(10);
		}
	});
});

describe('ActivityService.getZoneActivityScore', () => {
	let db;
	let service;

	beforeEach(() => {
		db = mockDb();
		service = new ActivityService(null, db);
	});

	it('returns 0 when no activity rows', async () => {
		db.rows = [{ msgs: 0, voice: 0 }];
		const score = await service.getZoneActivityScore('zone1');
		expect(score).toBe(0);
	});

	it('returns 1 when both targets are met', async () => {
		const Tm = Number(process.env.ACTIVITY_TARGET_MSGS) || 1000;
		const Tv = Number(process.env.ACTIVITY_TARGET_VOICE) || 600;
		db.rows = [{ msgs: Tm, voice: Tv }];
		const score = await service.getZoneActivityScore('zone1');
		expect(score).toBeCloseTo(1, 5);
	});

	it('weights msgs at 60% and voice at 40%', async () => {
		const Tm = Number(process.env.ACTIVITY_TARGET_MSGS) || 1000;
		// Only msgs at 100% target, no voice → score = 0.6
		db.rows = [{ msgs: Tm, voice: 0 }];
		const score = await service.getZoneActivityScore('zone1');
		expect(score).toBeCloseTo(0.6, 5);
	});

	it('clamps score to [0, 1]', async () => {
		db.rows = [{ msgs: 999999, voice: 999999 }];
		const score = await service.getZoneActivityScore('zone1');
		expect(score).toBeLessThanOrEqual(1);
		expect(score).toBeGreaterThanOrEqual(0);
	});

	it('queries with correct zone id and days', async () => {
		db.rows = [{ msgs: 0, voice: 0 }];
		await service.getZoneActivityScore('zone42', 7);
		const call = db.calls[0];
		expect(call.params).toContain('zone42');
		expect(call.params).toContain(7);
	});
});

describe('ActivityService.addMessage', () => {
	it('calls db.query with the zone id', async () => {
		const db = mockDb();
		const service = new ActivityService(null, db);
		await service.addMessage('z1');
		expect(db.calls).toHaveLength(1);
		expect(db.calls[0].params).toContain('z1');
	});
});
