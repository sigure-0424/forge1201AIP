const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotFML',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request' && data.channel === 'fml:loginwrapper') {
            // Unpack the request data
            const requestData = data.data;
            const channelLen = requestData[0];
            const channelStr = requestData.subarray(1, 1 + channelLen).toString();
            const payload = requestData.subarray(1 + channelLen);
            
            console.log('Server sent:', channelStr, payload);
            
            if (payload[0] === 0) {
                // ServerHello (Discriminator 0)
                // We should reply with ClientHello (Discriminator 1, FML Version 3)
                console.log('Sending ClientHello 01 03');
                
                const innerChannel = 'fml:handshake';
                const clientHelloPayload = Buffer.from([1, 3]);
                
                const responseData = Buffer.alloc(1 + innerChannel.length + clientHelloPayload.length);
                responseData.writeUInt8(innerChannel.length, 0);
                responseData.write(innerChannel, 1);
                clientHelloPayload.copy(responseData, 1 + innerChannel.length);
                
                bot._client.write('login_plugin_response', {
                    messageId: data.messageId,
                    successful: true,
                    data: responseData
                });
            } else if (payload[0] === 2) {
                // ModList from server
                console.log('Server sent ModList. We need to acknowledge or send ours?');
                // Usually we reply with an Ack or something.
            }
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
