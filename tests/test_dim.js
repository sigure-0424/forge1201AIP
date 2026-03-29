const mineflayer = require('mineflayer');
const bot = mineflayer.createBot({
    host: 'localhost',
    port: 25565,
    username: 'testbot',
    version: '1.20.1'
});
bot.on('spawn', () => {
    console.log('Dimension:', bot.game.dimension, typeof bot.game.dimension);
    process.exit(0);
});
