const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

let packetCount = 0;

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotFML',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request' && data.channel === 'fml:loginwrapper') {
            const requestData = data.data;
            const channelLen = requestData[0];
            const channelStr = requestData.subarray(1, 1 + channelLen).toString();
            const payload = requestData.subarray(1 + channelLen);
            
            console.log(`[Packet ${packetCount}] Server sent on ${channelStr}:`, payload.subarray(0, 20));
            
            if (packetCount === 0) {
                // Respond to first packet with ClientHello?
                const innerChannel = 'fml:handshake';
                const clientHelloPayload = Buffer.from([1, 3]); // Discriminator 1, FML Version 3
                
                const responseData = Buffer.alloc(1 + innerChannel.length + clientHelloPayload.length);
                responseData.writeUInt8(innerChannel.length, 0);
                responseData.write(innerChannel, 1);
                clientHelloPayload.copy(responseData, 1 + innerChannel.length);
                
                console.log('Replying with ClientHello');
                bot._client.write('login_plugin_response', {
                    messageId: data.messageId,
                    successful: true,
                    data: responseData
                });
            } else if (packetCount === 1) {
                // Respond to second packet with ModList Ack?
                // Let's just echo back the second packet? Or empty ModList?
                const innerChannel = 'fml:handshake';
                const ackPayload = Buffer.from([4]); // HandshakeAck
                const responseData = Buffer.alloc(1 + innerChannel.length + ackPayload.length);
                responseData.writeUInt8(innerChannel.length, 0);
                responseData.write(innerChannel, 1);
                ackPayload.copy(responseData, 1 + innerChannel.length);
                console.log('Replying with HandshakeAck');
                bot._client.write('login_plugin_response', {
                    messageId: data.messageId,
                    successful: true,
                    data: responseData
                });
            }
            packetCount++;
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
