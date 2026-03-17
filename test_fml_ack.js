const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotAck',
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

            console.log(`[Forge] Received discriminator: ${disc}`);

            const innerChannel = 'fml:handshake';
            let replyPayload = null;

            if (disc === 5) {
                // Try sending a HandshakeAck (maybe 0 or 4?)
                replyPayload = Buffer.from([1]); // ClientHello? 
            } else {
                replyPayload = Buffer.from([1, 3]); 
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
