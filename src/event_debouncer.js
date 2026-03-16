// event_debouncer.js
const { EventEmitter } = require('events');

class EventDebouncer extends EventEmitter {
    constructor(bot, debounceTimeMs = 500) {
        super();
        this.bot = bot;
        this.debounceTimeMs = debounceTimeMs;
        this.timer = null;
        this.isCascadingWait = false;

        this.setupListeners();
    }

    setupListeners() {
        this.bot.on('blockUpdate', (oldBlock, newBlock) => {
            // Only care if block was broken
            if (oldBlock && oldBlock.type !== 0 && newBlock && newBlock.type === 0) {
                this.handleBlockBreak();
            }
        });
    }

    handleBlockBreak() {
        if (!this.isCascadingWait) {
            console.log('[EventDebouncer] Mass destruction detected. Entering CASCADING_WAIT state.');
            this.isCascadingWait = true;
            this.emit('cascading_wait_start');
        }

        if (this.timer) {
            clearTimeout(this.timer);
        }

        this.timer = setTimeout(() => {
            console.log('[EventDebouncer] Terrain synchronization complete. Exiting CASCADING_WAIT state.');
            this.isCascadingWait = false;
            this.emit('cascading_wait_end');
        }, this.debounceTimeMs);
    }
}

module.exports = EventDebouncer;
