const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotHS',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request' && data.channel === 'fml:loginwrapper') {
            const requestData = data.data;
            const channelLen = requestData[0];
            const channelStr = requestData.subarray(1, 1 + channelLen).toString();
            const wrapperPayload = requestData.subarray(1 + channelLen);
            
            let offset = 0;
            let numRead = 0;
            let length = 0;
            let read;
            do {
                read = wrapperPayload.readUInt8(offset + numRead);
                let value = (read & 0b01111111);
                length |= (value << (7 * numRead));
                numRead++;
            } while ((read & 0b10000000) != 0);
            
            offset += numRead;
            const disc = wrapperPayload.readUInt8(offset);
            offset++;

            console.log(`\n[Forge] Received discriminator: ${disc} on ${channelStr}`);
            console.log(`[Forge] Payload length: ${length}`);

            const innerChannel = 'fml:handshake';
            let replyPayload = null;

            if (disc === 5) {
                // Server ModList?
                console.log("[Forge] Server sent ModList. Replying with Client ModList (Disc 2? or 5?)");
                // Let's reply with an empty ModList but maybe discriminator is 5?
                // Or maybe discriminator is 2.
                // Let's try sending discriminator 5, length 0 (0 mods).
                replyPayload = Buffer.from([5, 0]); 
            } else if (disc === 0) {
                console.log("[Forge] Server sent ServerHello. Replying with ClientHello (Disc 1, FML ver 3)");
                replyPayload = Buffer.from([1, 3]);
            } else if (disc === 3) {
                console.log("[Forge] Server sent RegistryData. Replying with HandshakeAck?");
                replyPayload = Buffer.from([4]); 
            } else {
                console.log(`[Forge] Unknown discriminator ${disc}. Replying with Ack (4)`);
                replyPayload = Buffer.from([4]);
            }

            if (replyPayload) {
                // Construct wrapped response
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
        } else if (meta.name === 'login_plugin_request') {
            console.log(`[LoginPluginRequest] Unknown channel: ${data.channel}`);
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
