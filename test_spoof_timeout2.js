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
            console.log('Got login_plugin_request for fml:loginwrapper with ID', data.messageId);
            
            const innerChannel = 'fml:handshake';
            const responseData = Buffer.alloc(1 + innerChannel.length + 3); // 1 len + 13 chars + 1 varint + 1 disc + 1 fmlver
            responseData.writeUInt8(innerChannel.length, 0);
            responseData.write(innerChannel, 1);
            responseData.writeUInt8(2, 1 + innerChannel.length); // Varint Length 2
            responseData.writeUInt8(1, 2 + innerChannel.length); // Discriminator 1 (ClientHello)
            responseData.writeUInt8(3, 3 + innerChannel.length); // FML version 3
            
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
}, 5000);
