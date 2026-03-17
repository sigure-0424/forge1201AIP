const mineflayer = require('mineflayer');

const host = process.env.MC_HOST || 'localhost';
const port = parseInt(process.env.MC_PORT || '25565', 10);

console.log(`Testing connection to ${host}:${port}`);

const bot = mineflayer.createBot({
    host: host + '\0FML3\0',
    port: port,
    username: 'TestBot',
    version: '1.20.1'
});

bot.on('inject_allowed', () => {
    console.log('Inject allowed. Listening to all packets...');
    
    bot._client.on('packet', (data, meta) => {
        if (meta.state === 'login' || meta.name === 'login_plugin_request' || meta.name === 'custom_payload' || meta.name === 'disconnect') {
            console.log(`[PACKET IN] ${meta.state} | ${meta.name} |`, JSON.stringify(data).substring(0, 500));
        }

        if (meta.name === 'login_plugin_request') {
            console.log('Responding to login_plugin_request with ID', data.messageId, 'channel', data.channel);
            
            let responseData = Buffer.alloc(0);
            
            if (data.channel === 'fml:loginwrapper') {
                // The request data likely starts with a string representing the inner channel
                // Let's just try sending a wrapped reply back
                const innerChannel = 'fml:handshake';
                const payload = Buffer.from([0x01]); // 0x01 might be Ack or ClientHello? Let's just try 0x01
                responseData = Buffer.alloc(1 + innerChannel.length + payload.length);
                responseData.writeUInt8(innerChannel.length, 0);
                responseData.write(innerChannel, 1);
                payload.copy(responseData, 1 + innerChannel.length);
            }

            bot._client.write('login_plugin_response', {
                messageId: data.messageId,
                successful: true,
                data: responseData
            });
        }
    });

    const originalWrite = bot._client.write.bind(bot._client);
    bot._client.write = (name, data) => {
        if (name === 'login_plugin_response' || name === 'custom_payload' || name === 'login') {
            console.log(`[PACKET OUT] ${name} |`, JSON.stringify(data).substring(0, 500));
        }
        originalWrite(name, data);
    };
});

bot.on('kicked', (reason) => {
    console.log('Kicked!', reason);
    process.exit(1);
});

bot.on('error', (err) => {
    console.error('Error!', err);
    process.exit(1);
});

