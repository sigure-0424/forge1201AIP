const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotSpoofT',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request' && data.channel === 'fml:loginwrapper') {
            const innerChannel = 'fml:handshake';
            
            // Discriminator 1 (ClientHello), FML Version 3
            // Discriminator 2 (ModList), Size 0
            const payload = Buffer.from([1, 3, 2, 0]);
            
            const responseData = Buffer.alloc(1 + innerChannel.length + 1 + payload.length);
            responseData.writeUInt8(innerChannel.length, 0);
            responseData.write(innerChannel, 1);
            responseData.writeUInt8(payload.length, 1 + innerChannel.length);
            payload.copy(responseData, 2 + innerChannel.length);
            
            bot._client.write('login_plugin_response', {
                messageId: data.messageId,
                successful: true,
                data: responseData
            });
        }
    });
});

bot.on('kicked', (reason) => {
    console.log('Kicked:', reason);
    process.exit(1);
});
bot.on('error', (err) => {
    console.log('Error:', err);
    process.exit(1);
});
bot.on('login', () => {
    console.log('Logged in successfully!');
    process.exit(0);
});

setTimeout(() => {
    console.log('Timeout reached. Exiting.');
    process.exit(0);
}, 3000);
