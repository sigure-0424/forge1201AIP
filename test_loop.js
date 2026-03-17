const mineflayer = require('mineflayer');
const host = process.env.MC_HOST || 'host.docker.internal';

function testDiscriminator(disc) {
    return new Promise((resolve) => {
        const bot = mineflayer.createBot({
            host: host + '\0FML3\0',
            port: 25565,
            username: 'TestBot' + disc,
            version: '1.20.1'
        });

        bot.on('inject_allowed', () => {
            bot._client.on('packet', (data, meta) => {
                if (meta.name === 'login_plugin_request' && data.channel === 'fml:loginwrapper') {
                    const innerChannel = 'fml:handshake';
                    const payload = Buffer.from([disc, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]); // Padded with zeros
                    const responseData = Buffer.alloc(1 + innerChannel.length + payload.length);
                    responseData.writeUInt8(innerChannel.length, 0);
                    responseData.write(innerChannel, 1);
                    payload.copy(responseData, 1 + innerChannel.length);
                    bot._client.write('login_plugin_response', {
                        messageId: data.messageId,
                        successful: true,
                        data: responseData
                    });
                }
            });
        });

        bot.on('kicked', (reason) => {
            console.log(`[Disc ${disc}] Kicked:`, reason.substring(0, 80));
            resolve();
        });
        
        bot.on('error', () => { resolve(); });
    });
}

async function run() {
    for (let i = 0; i < 5; i++) {
        await testDiscriminator(i);
    }
}
run();
