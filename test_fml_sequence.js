const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotFML6',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    const listeners = bot._client.listeners('login_plugin_request');
    for (const l of listeners) {
        bot._client.removeListener('login_plugin_request', l);
    }
    console.log(`Removed ${listeners.length} default login_plugin_request listeners.`);

    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request') {
            console.log(`\n[IN] login_plugin_request ID=${data.messageId} channel=${data.channel}`);
            
            if (data.channel === 'fml:loginwrapper') {
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

                console.log(`[Forge] discriminator=${disc} on inner channel=${channelStr}`);

                const innerChannel = 'fml:handshake';
                let replyPayload = null;

                if (disc === 5) {
                    // S2CModData - noResponse()
                    console.log("[Forge] S2CModData: replying with properly wrapped empty data");
                    replyPayload = Buffer.alloc(0);
                } else if (disc === 1) {
                    // S2CModList
                    console.log("[Forge] S2CModList: replying with C2SModListReply (disc 2)");
                    // C2SModListReply format: Discriminator (2), mods size (VarInt), channels size (VarInt), registries size (VarInt)
                    // Let's send 0 for all three lists: Discriminator 2 + length 0 + length 0 + length 0
                    replyPayload = Buffer.from([2, 0, 0, 0]); 
                } else if (disc === 3 || disc === 4) {
                    // S2CRegistry or S2CConfigData
                    console.log(`[Forge] S2CRegistry/ConfigData: replying with C2SAcknowledge (disc 99)`);
                    replyPayload = Buffer.from([99]);
                } else {
                    console.log(`[Forge] Unknown disc ${disc}: replying with C2SAcknowledge (disc 99)`);
                    replyPayload = Buffer.from([99]); 
                }

                if (replyPayload) {
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
                    console.log(`[Forge] Sent reply for discriminator ${disc} -> ${replyPayload[0]}`);
                }
            } else {
                bot._client.write('login_plugin_response', {
                    messageId: data.messageId,
                    successful: true,
                    data: Buffer.alloc(0)
                });
                console.log(`[Forge] Acknowledged other plugin request`);
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

setTimeout(() => {
    console.log('Timeout. Exiting.');
    process.exit(0);
}, 5000);
