const mc = require('minecraft-protocol');
const net = require('net');
const { EventEmitter } = require('events');

class MockForgeServer extends EventEmitter {
    constructor(port = 25565) {
        super();
        this.port = port;
        this.server = net.createServer((socket) => {
            console.log(`[MockServer] New connection from ${socket.remoteAddress}`);
            
            const client = new mc.Client(true, '1.20.1');
            client.setSocket(socket);

            client.on('packet', (data, meta) => {
                const { name } = meta;
                const params = data;
                
                if (name !== 'ping') {
                    console.log(`[MockServer] Received packet: ${name} in state ${client.state}`);
                }

                if (name === 'set_protocol') {
                    client.state = 'login';
                } else if (name === 'login_start') {
                    console.log(`[MockServer] Received login_start for ${params.username}`);
                    client.username = params.username;
                    this.handleHandshake(client);
                } else if (name === 'login_plugin_response') {
                    if (params.data) {
                        this.handleFmlResponse(params, client);
                    }
                }
            });

            client.on('error', (err) => {
                console.error(`[MockServer] Client error: ${err.message}`);
            });
            
            client.on('end', () => {
                console.log(`[MockServer] Client disconnected`);
            });
        });

        this.server.listen(this.port, '0.0.0.0');
    }

    handleHandshake(client) {
        // 1. Send ServerHello (Disc 0)
        console.log('[MockServer] Sending ServerHello');
        this.sendFmlPacket(client, 0, Buffer.from([0x00, 0x03]), 1); 
    }

    handleFmlResponse(params, client) {
        const wrapperData = params.data;
        let offset = 0;
        const { value: channelLen, bytesRead: clBr } = this.readVarInt(wrapperData, offset);
        offset += clBr;
        const channelName = wrapperData.toString('utf8', offset, offset + channelLen);
        offset += channelLen;
        const { value: payloadLen, bytesRead: plBr } = this.readVarInt(wrapperData, offset);
        offset += plBr;
        const payload = wrapperData.subarray(offset, offset + payloadLen);

        const disc = payload[0];
        console.log(`[MockServer] Received client response on ${channelName}, discriminator: ${disc}`);

                if (disc === 1) {
            console.log('[MockServer] Received ClientHello. Sending ModList (Disc 1)');
            const modList = this.buildModList();
            this.sendFmlPacket(client, 1, modList, 2);
        } else if (disc === 2) {
            console.log('[MockServer] Received ModListReply. Sending Registry (Disc 3)');
            this.sendFmlPacket(client, 3, Buffer.from([0x03, 0x00]), 3); 
        } else if (disc === 4 || disc === 99) {
            console.log('[MockServer] Received HandshakeAck. Completing login.');
            client.write('success', {
                uuid: '00000000-0000-0000-0000-000000000000',
                username: client.username,
                properties: []
            });
            // State should change to Play here
            setTimeout(() => { client.state = 'play'; }, 50);
        }
    }

    sendFmlPacket(client, disc, payload, messageId) {
        const innerChannel = 'fml:handshake';
        
        const channelBuf = this.writeUtf(innerChannel);
        const payloadLenBuf = this.writeVarIntBuf(payload.length);
        const wrapperData = Buffer.concat([channelBuf, payloadLenBuf, payload]);

        client.write('login_plugin_request', {
            messageId: messageId,
            channel: 'fml:loginwrapper',
            data: wrapperData
        });
    }

    buildModList() {
        // [disc 1, list<string> mods, map<string,string> channels, varint registrySize]
        // Let's just send empty list for now
        return Buffer.from([0x01, 0x00, 0x00, 0x00, 0x00]);
    }

    // Utilities
    readVarInt(buffer, offset) {
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

    writeVarIntBuf(value) {
        const bytes = [];
        do {
            let temp = (value & 0b01111111);
            value >>>= 7;
            if (value != 0) temp |= 0b10000000;
            bytes.push(temp);
        } while (value != 0);
        return Buffer.from(bytes);
    }

    writeUtf(str) {
        const strBuf = Buffer.from(str, 'utf8');
        return Buffer.concat([this.writeVarIntBuf(strBuf.length), strBuf]);
    }

    close() {
        this.server.close();
    }
}

if (require.main === module) {
    const server = new MockForgeServer();
    console.log('[MockServer] Listening on 25565');
}

module.exports = MockForgeServer;
