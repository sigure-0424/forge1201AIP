const mc = require('minecraft-protocol');
const net = require('net');
const { EventEmitter } = require('events');

class MockForgeServer extends EventEmitter {
    constructor(port = 25565) {
        super();
        this.port = port;
        this.server = net.createServer((socket) => {
            console.log(`[MockServer] New connection from ${socket.remoteAddress}`);
            
            const mcData = require('minecraft-data')('1.20.1');
            const serializer = mc.createSerializer({ state: 'handshaking', isServer: true, version: '1.20.1' });
            const deserializer = mc.createDeserializer({ state: 'handshaking', isServer: true, version: '1.20.1' });

            socket.pipe(deserializer);
            serializer.pipe(socket);

            let currentState = 'handshaking';

            deserializer.on('data', (packet) => {
                const { name, params } = packet.data;
                console.log(`[MockServer] Received packet: ${name} in state ${currentState}`);

                if (name === 'set_protocol') {
                    currentState = params.nextState === 1 ? 'status' : 'login';
                    serializer.state = currentState;
                    deserializer.state = currentState;
                } else if (name === 'login_start') {
                    console.log(`[MockServer] Received login_start for ${params.username}`);
                    this.handleHandshake(params.username, serializer, deserializer, socket);
                }
            });

            deserializer.on('error', (err) => {
                console.error(`[MockServer] Deserializer error: ${err.message}`);
            });
        });

        this.server.listen(this.port, '0.0.0.0');
    }

    handleHandshake(username, serializer, deserializer, socket) {
        const innerChannel = 'fml:handshake';

        // 1. Send ServerHello (Disc 0)
        console.log('[MockServer] Sending ServerHello');
        this.sendFmlPacket(serializer, 0, Buffer.from([1, 3]), 1); 

        deserializer.on('data', (packet) => {
            const { name, params } = packet.data;
            if (name === 'login_plugin_response') {
                if (params.successful && params.data) {
                    this.handleFmlResponse(params, serializer, deserializer, socket, username);
                }
            }
        });
    }

    handleFmlResponse(params, serializer, deserializer, socket, username) {
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
            this.sendFmlPacket(serializer, 1, modList, 2);
        } else if (disc === 2) {
            console.log('[MockServer] Received ModListReply. Sending Registry (Disc 3)');
            this.sendFmlPacket(serializer, 3, Buffer.from([0]), 3); 
        } else if (disc === 99) {
            console.log('[MockServer] Received HandshakeAck. Completing login.');
            serializer.write('success', {
                uuid: '00000000-0000-0000-0000-000000000000',
                username: username,
                properties: []
            });
            // State should change to Play here
            serializer.state = 'play';
            deserializer.state = 'play';
        }
    }

    sendFmlPacket(serializer, disc, payload, messageId) {
        const innerChannel = 'fml:handshake';
        const innerPayload = Buffer.concat([Buffer.from([disc]), payload]);
        
        const channelBuf = this.writeUtf(innerChannel);
        const payloadLenBuf = this.writeVarIntBuf(innerPayload.length);
        const wrapperData = Buffer.concat([channelBuf, payloadLenBuf, innerPayload]);

        serializer.write('login_plugin_request', {
            messageId: messageId,
            channel: 'fml:loginwrapper',
            data: wrapperData
        });
    }

    buildModList() {
        const parts = [];
        parts.push(this.writeList(['minecraft', 'forge'], (v) => this.writeUtf(v)));
        parts.push(this.writeVarIntBuf(0)); 
        parts.push(this.writeVarIntBuf(0)); 
        parts.push(this.writeVarIntBuf(0)); 
        return Buffer.concat(parts);
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

    writeList(list, elementWriter) {
        const bufs = [this.writeVarIntBuf(list.length)];
        for (const el of list) {
            bufs.push(elementWriter(el));
        }
        return Buffer.concat(bufs);
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
