const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotFML7',
    version: '1.20.1'
});

function readVarInt(buffer, offset) {
    let numRead = 0;
    let result = 0;
    let read;
    do {
        read = buffer.readUInt8(offset + numRead);
        let value = (read & 0b01111111);
        result |= (value << (7 * numRead));
        numRead++;
    } while ((read & 0b10000000) != 0);
    return { value: result, bytesRead: numRead };
}

function readUtf(buffer, offset) {
    const { value: len, bytesRead } = readVarInt(buffer, offset);
    offset += bytesRead;
    const str = buffer.toString('utf8', offset, offset + len);
    offset += len;
    return { value: str, newOffset: offset };
}

function writeVarInt(value) {
    const bytes = [];
    do {
        let temp = (value & 0b01111111);
        value >>>= 7;
        if (value != 0) temp |= 0b10000000;
        bytes.push(temp);
    } while (value != 0);
    return Buffer.from(bytes);
}

function writeUtf(str) {
    const strBuf = Buffer.from(str, 'utf8');
    return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

bot.on('inject_allowed', () => {
    const listeners = bot._client.listeners('login_plugin_request');
    for (const l of listeners) {
        bot._client.removeListener('login_plugin_request', l);
    }

    bot._client.on('packet', (data, meta) => {
        if (meta.name === 'login_plugin_request') {
            if (data.channel === 'fml:loginwrapper') {
                const wrapperPayload = data.data.subarray(1 + data.data[0]); // skip channel len and channel string
                const payloadLenData = readVarInt(wrapperPayload, 0);
                const payload = wrapperPayload.subarray(payloadLenData.bytesRead, payloadLenData.bytesRead + payloadLenData.value);
                const disc = payload[0];

                console.log(`[Forge] discriminator=${disc}`);

                const innerChannel = 'fml:handshake';
                let replyPayload = null;

                if (disc === 5) {
                    replyPayload = Buffer.alloc(0);
                } else if (disc === 1) { // S2CModList
                    console.log("[Forge] Extracting server mods and channels...");
                    let offset = 1; // skip discriminator
                    
                    // read mods
                    const { value: modsLen, bytesRead: modsBr } = readVarInt(payload, offset);
                    offset += modsBr;
                    let mods = [];
                    for (let i = 0; i < modsLen; i++) {
                        const { value, newOffset } = readUtf(payload, offset);
                        mods.push(value);
                        offset = newOffset;
                    }
                    console.log(`Server has ${modsLen} mods.`);

                    // read channels
                    const { value: channelsLen, bytesRead: channelsBr } = readVarInt(payload, offset);
                    offset += channelsBr;
                    let channels = [];
                    for (let i = 0; i < channelsLen; i++) {
                        const { value: rl, newOffset: no1 } = readUtf(payload, offset);
                        offset = no1;
                        const { value: v, newOffset: no2 } = readUtf(payload, offset);
                        offset = no2;
                        channels.push({ rl, v });
                    }
                    console.log(`Server has ${channelsLen} channels.`);

                    // Build C2SModListReply
                    const parts = [Buffer.from([2])]; // Disc 2
                    
                    parts.push(writeVarInt(mods.length));
                    for (const m of mods) parts.push(writeUtf(m));
                    
                    parts.push(writeVarInt(channels.length));
                    for (const c of channels) {
                        parts.push(writeUtf(c.rl));
                        parts.push(writeUtf(c.v));
                    }
                    
                    // registries map length 0
                    parts.push(writeVarInt(0));
                    
                    replyPayload = Buffer.concat(parts);
                    console.log("[Forge] Sending copied ModList and Channels");
                } else if (disc === 3 || disc === 4) {
                    replyPayload = Buffer.from([99]);
                } else {
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
                }
            } else {
                bot._client.write('login_plugin_response', {
                    messageId: data.messageId,
                    successful: true,
                    data: Buffer.alloc(0)
                });
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
}, 8000);
