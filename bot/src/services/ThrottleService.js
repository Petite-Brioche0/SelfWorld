class ThrottleService {
        constructor({ cleanupIntervalMs = 60_000, lockTimeoutMs = 3_000 } = {}) {
                this.cooldowns = new Map();
                this.inflight = new Map();
                this.lockTimeoutMs = lockTimeoutMs;
                this.cleanupInterval = setInterval(() => this.cleanup(), cleanupIntervalMs).unref?.();
        }

        #key(userId, actionKey) {
                return `${userId}:${actionKey}`;
        }

        async begin(userId, actionKey, seconds) {
                if (!userId || !actionKey || !Number.isFinite(seconds)) {
                        return { ok: true, retrySec: 0 };
                }

                const now = Date.now();
                const lockExpiry = this.inflight.get(String(userId));
                if (lockExpiry && lockExpiry > now) {
                        const retrySec = Math.ceil((lockExpiry - now) / 1000);
                        return { ok: false, retrySec };
                }

                const key = this.#key(userId, actionKey);
                const expiresAt = this.cooldowns.get(key);
                if (expiresAt && expiresAt > now) {
                        const retrySec = Math.ceil((expiresAt - now) / 1000);
                        return { ok: false, retrySec };
                }

                this.inflight.set(String(userId), now + this.lockTimeoutMs);
                this.cooldowns.set(key, now + seconds * 1000);

                return { ok: true, retrySec: 0 };
        }

        async end(userId, actionKey) {
                if (userId) {
                        const lockExpiry = this.inflight.get(String(userId));
                        if (!lockExpiry || lockExpiry <= Date.now()) {
                                this.inflight.delete(String(userId));
                        } else {
                                this.inflight.delete(String(userId));
                        }
                }

                if (userId && actionKey) {
                        const key = this.#key(userId, actionKey);
                        const expiresAt = this.cooldowns.get(key);
                        if (expiresAt && expiresAt <= Date.now()) {
                                this.cooldowns.delete(key);
                        }
                }
        }

        cleanup() {
                const now = Date.now();
                for (const [key, expiresAt] of this.cooldowns.entries()) {
                        if (expiresAt <= now) {
                                this.cooldowns.delete(key);
                        }
                }
                for (const [userId, lockExpiry] of this.inflight.entries()) {
                        if (lockExpiry <= now) {
                                this.inflight.delete(userId);
                        }
                }
        }
}

module.exports = { ThrottleService };
