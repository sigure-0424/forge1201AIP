const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotAdv',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request' && data.channel === 'fml:loginwrapper') {
            const requestData = data.data;
            const channelLen = requestData[0];
            const payload = requestData.subarray(1 + channelLen);
            const disc = payload[0];

            console.log(`[Forge] Received discriminator: ${disc}`);

            const innerChannel = 'fml:handshake';
            let replyPayload = null;

            if (disc === 0) {
                // ServerHello -> send ClientHello (1) + FML version (3)
                replyPayload = Buffer.from([1, 3]);
            } else if (disc === 2) {
                // ModList from Server -> send our ModList (2)
                // Let's send an empty modlist: Discriminator 2 + length 0
                replyPayload = Buffer.from([2, 0]);
            } else if (disc === 3) {
                // Server Registry Data -> send Ack (4)?
                replyPayload = Buffer.from([4]);
            } else {
                console.log(`Unhandled discriminator ${disc}`);
                replyPayload = Buffer.from([4]); // Default to Ack?
            }

            if (replyPayload) {
                // Construct wrapped response
                // Structure: Channel Length (1 byte) | Channel String | Payload Length (VarInt) | Payload
                // Note: The payload length inside the wrapper might be treated as a varint by Minecraft's packet reader, or just remaining bytes.
                // Let's try prepending the VarInt length of the reply payload
                const responseData = Buffer.alloc(1 + innerChannel.length + 1 + replyPayload.length);
                responseData.writeUInt8(innerChannel.length, 0);
                responseData.write(innerChannel, 1);
                responseData.writeUInt8(replyPayload.length, 1 + innerChannel.length);
                replyPayload.copy(responseData, 2 + innerChannel.length);

                bot._client.write('login_plugin_response', {
                    messageId: data.messageId,
                    successful: true,
                    data: responseData
                });
                console.log(`[Forge] Sent reply for discriminator ${disc}`);
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
