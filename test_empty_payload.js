const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotEmpty',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request' && data.channel === 'fml:loginwrapper') {
            const innerChannel = 'fml:handshake';
            
            // Length of inner channel (1 byte) + inner channel string + VarInt length of payload (1 byte, 0)
            const responseData = Buffer.alloc(1 + innerChannel.length + 1);
            responseData.writeUInt8(innerChannel.length, 0);
            responseData.write(innerChannel, 1);
            responseData.writeUInt8(0, 1 + innerChannel.length); // Payload length = 0
            
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
