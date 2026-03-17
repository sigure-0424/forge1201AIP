const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotEchoP',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request' || meta.name === 'custom_payload') {
            console.log('IN:', meta.name, data.channel);
        }
        if (meta.name === 'login_plugin_request') {
            console.log('Echoing ID', data.messageId);
            bot._client.write('login_plugin_response', {
                messageId: data.messageId,
                successful: true,
                data: data.data
            });
        }
    });
});

setTimeout(() => {
    console.log('Timeout. Exiting.');
    process.exit(0);
}, 3000);
