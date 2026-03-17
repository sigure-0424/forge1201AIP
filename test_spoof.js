const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotSpoof',
    version: '1.20.1'
});

function createString(str) {
    const len = Buffer.alloc(1);
    len.writeUInt8(str.length, 0); // Assuming length is small enough for 1 byte VarInt
    return Buffer.concat([len, Buffer.from(str)]);
}

bot.on('inject_allowed', () => {
    let packetCount = 0;
    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request' && data.channel === 'fml:loginwrapper') {
            const innerChannel = 'fml:handshake';
            
            let payload;
            if (packetCount === 0) {
                // Try to send Client ModList
                // Discriminator 05?
                // Number of mods: 2
                const mods = [
                    Buffer.concat([createString('minecraft'), createString('1.20.1')]),
                    Buffer.concat([createString('forge'), createString('47.1.0')])
                ];
                payload = Buffer.concat([Buffer.from([5, 2]), ...mods]);
            } else {
                // Try to send HandshakeAck (maybe discriminator 4 or 2 or 1?)
                // Let's send 1 (Ack?)
                payload = Buffer.from([1]);
            }
            
            const payloadLen = Buffer.alloc(1);
            payloadLen.writeUInt8(payload.length, 0);
            
            const responseData = Buffer.concat([
                Buffer.from([innerChannel.length]),
                Buffer.from(innerChannel),
                payloadLen,
                payload
            ]);
            
            bot._client.write('login_plugin_response', {
                messageId: data.messageId,
                successful: true,
                data: responseData
            });
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
