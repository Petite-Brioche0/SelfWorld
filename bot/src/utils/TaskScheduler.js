// Task scheduler for managing periodic background tasks with lifecycle management, error handling, and observability

class TaskScheduler {
	constructor(logger = null) {
		this.tasks = new Map();
		this.logger = logger;
	}

	/**
	 * Schedule a periodic task
	 * @param {string} name - Unique task identifier
	 * @param {number} intervalMs - Interval in milliseconds
	 * @param {Function} taskFn - Async function to execute
	 * @param {Object} options - Configuration options
	 * @param {number} options.timeout - Max execution time in ms (default: no timeout)
	 * @param {number} options.initialDelay - Delay before first run in ms (default: 0)
	 */
	schedule(name, intervalMs, taskFn, options = {}) {
		if (this.tasks.has(name)) {
			throw new Error(`Task "${name}" is already scheduled`);
		}

		const taskState = {
			name,
			intervalMs,
			taskFn,
			options,
			intervalHandle: null,
			timeoutHandle: null,
			running: false,
			lastRun: null,
			lastSuccess: null,
			lastError: null,
			runCount: 0,
			errorCount: 0
		};

		const executeTask = async () => {
			// Prevent concurrent execution
			if (taskState.running) {
				this.logger?.warn?.({ task: name }, 'Task already running, skipping this interval');
				return;
			}

			taskState.running = true;
			taskState.lastRun = Date.now();
			taskState.runCount++;

			try {
				// Execute with optional timeout
				if (options.timeout) {
					await this.#withTimeout(taskFn(), options.timeout, name);
				} else {
					await taskFn();
				}

				taskState.lastSuccess = Date.now();
				this.logger?.debug?.({ task: name }, 'Task completed successfully');
			} catch (error) {
				taskState.lastError = {
					message: error.message,
					timestamp: Date.now()
				};
				taskState.errorCount++;
				this.logger?.error?.({ err: error, task: name }, 'Task execution failed');
			} finally {
				taskState.running = false;
			}
		};

		// Schedule with optional initial delay
		const initialDelay = options.initialDelay || 0;
		if (initialDelay > 0) {
			setTimeout(() => {
				executeTask();
				taskState.intervalHandle = setInterval(executeTask, intervalMs);
			}, initialDelay);
		} else {
			taskState.intervalHandle = setInterval(executeTask, intervalMs);
		}

		this.tasks.set(name, taskState);
		this.logger?.info?.({ task: name, intervalMs }, 'Task scheduled');
	}

	/**
	 * Execute a function with timeout
	 * @private
	 */
	#withTimeout(promise, timeoutMs, taskName) {
		let timer;
		return Promise.race([
			promise.finally(() => clearTimeout(timer)),
			new Promise((_, reject) => {
				timer = setTimeout(() => {
					reject(new Error(`Task "${taskName}" timed out after ${timeoutMs}ms`));
				}, timeoutMs);
			})
		]);
	}

	/**
	 * Cancel a specific task
	 * @param {string} name - Task name to cancel
	 */
	cancel(name) {
		const taskState = this.tasks.get(name);
		if (!taskState) {
			this.logger?.warn?.({ task: name }, 'Task not found for cancellation');
			return false;
		}

		if (taskState.intervalHandle) {
			clearInterval(taskState.intervalHandle);
		}
		if (taskState.timeoutHandle) {
			clearTimeout(taskState.timeoutHandle);
		}

		this.tasks.delete(name);
		this.logger?.info?.({ task: name }, 'Task cancelled');
		return true;
	}

	/**
	 * Get status of a specific task
	 * @param {string} name - Task name
	 * @returns {Object|null} Task status or null if not found
	 */
	getStatus(name) {
		const taskState = this.tasks.get(name);
		if (!taskState) return null;

		return {
			name: taskState.name,
			intervalMs: taskState.intervalMs,
			running: taskState.running,
			lastRun: taskState.lastRun,
			lastSuccess: taskState.lastSuccess,
			lastError: taskState.lastError,
			runCount: taskState.runCount,
			errorCount: taskState.errorCount
		};
	}

	/**
	 * Get status of all tasks
	 * @returns {Array} Array of task statuses
	 */
	getAllStatuses() {
		return Array.from(this.tasks.keys()).map(name => this.getStatus(name));
	}

	/**
	 * Gracefully shutdown all tasks
	 * Waits for running tasks to complete before canceling intervals
	 * @param {number} maxWaitMs - Max time to wait for running tasks (default: 30s)
	 */
	async shutdown(maxWaitMs = 30000) {
		this.logger?.info?.('Shutting down task scheduler...');

		// Cancel all intervals first to prevent new executions
		for (const taskState of this.tasks.values()) {
			if (taskState.intervalHandle) {
				clearInterval(taskState.intervalHandle);
				taskState.intervalHandle = null;
			}
		}

		// Wait for running tasks to complete
		const startTime = Date.now();
		const runningTasks = Array.from(this.tasks.values()).filter(t => t.running);

		if (runningTasks.length > 0) {
			this.logger?.info?.({ count: runningTasks.length }, 'Waiting for running tasks to complete...');

			while (runningTasks.some(t => t.running)) {
				if (Date.now() - startTime > maxWaitMs) {
					this.logger?.warn?.('Shutdown timeout reached, forcing exit');
					break;
				}
				await new Promise(resolve => setTimeout(resolve, 100));
			}
		}

		this.tasks.clear();
		this.logger?.info?.('Task scheduler shutdown complete');
	}
}

module.exports = { TaskScheduler };
