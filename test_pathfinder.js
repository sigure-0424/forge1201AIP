const mineflayer = require('mineflayer');
const { pathfinder, Movements } = require('mineflayer-pathfinder');

const bot = mineflayer.createBot({
    username: 'test',
    version: '1.20.1',
    offline: true,
});
bot.loadPlugin(pathfinder);

bot.once('spawn', () => {
    const mcData = require('minecraft-data')(bot.version);
    const movements = new Movements(bot, mcData);
    console.log(Array.from(movements.blocksCantBreak));
    process.exit(0);
});
