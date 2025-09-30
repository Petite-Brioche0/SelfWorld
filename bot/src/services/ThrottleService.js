const { RateLimiterMemory } = require('rate-limiter-flexible');

class ThrottleService {
        constructor({ points = 20, duration = 10 } = {}) {
                this.limiter = new RateLimiterMemory({ points, duration });
        }
        // weight = cost in points; label used for logs only
        async consume(userId, weight = 1, label = 'generic') {
                try {
                        await this.limiter.consume(String(userId), weight);
                        return { ok: true };
                } catch (e) {
                        const ms = Math.max(0, e.msBeforeNext || 0);
                        return { ok: false, retryMs: ms };
                }
        }
}
module.exports = { ThrottleService };
