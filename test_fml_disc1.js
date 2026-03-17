const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: 25565,
    username: 'TestBotFML5',
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
            console.log(`[IN] login_plugin_request ID=${data.messageId} channel=${data.channel}`);
            
            if (data.channel === 'fml:loginwrapper') {
                const innerChannel = 'fml:handshake';
                
                // Let's send an Ack, maybe discriminator is 99 (Invalid) to see what the server logs?
                // Or let's send Discriminator 2 (ModList) with 0 mods.
                // Or Discriminator 1 (ClientHello) with FML version 3.
                // Let's try Discriminator 1 (ClientHello) with FML version 3: [1, 3]
                // and see if the server asks for more.
                const replyPayload = Buffer.from([1, 3]);

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
                console.log(`[Forge] Sent ClientHello (disc 1, FML 3)`);
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
}, 3000);
