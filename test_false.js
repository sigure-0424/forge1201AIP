const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotFalse',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request') {
            console.log('Got', data.channel);
            bot._client.write('login_plugin_response', {
                messageId: data.messageId,
                successful: false
            });
        }
    });
});

bot.on('login', () => {
    console.log('Logged in successfully!');
    process.exit(0);
});

bot.on('kicked', (reason) => {
    console.log('Kicked:', reason);
    process.exit(1);
});
bot.on('error', (err) => {
    console.log('Error:', err);
    process.exit(1);
});
