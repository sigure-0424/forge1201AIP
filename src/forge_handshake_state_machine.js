const { EventEmitter } = require('events');

class ForgeHandshakeStateMachine extends EventEmitter {
    constructor(client) {
        super();
        this.client = client;
        this.state = 'INIT';
        this.registrySyncBuffer = [];
        this.innerChannel = 'fml:handshake';
        this.completed = false;

        // Intercept incoming packets
        const packetListener = (data, meta) => {
            if (this.client.state !== 'login') return;

            if (meta.name === 'login_plugin_request') {
                if (data.channel === 'fml:loginwrapper') {
                    this.handleLoginWrapper(data);
                } else {
                    // Acknowledge other plugins as unknown
                    this.client.write('login_plugin_response', {
                        messageId: data.messageId,
                        successful: false
                    });
                }
            }
        };

        this.client.on('packet', packetListener);

        // Transition to PLAY state usually happens after the 'success' packet
        this.client.once('success', () => {
            if (!this.completed) {
                this.completed = true;
                this.emit('handshake_complete', this.registrySyncBuffer);
            }
            this.client.removeListener('packet', packetListener);
        });
    }

    handleLoginWrapper(packet) {
        const wrapperData = packet.data;
        try {
            // Read inner channel
            const { value: channelLen, bytesRead: clBr } = this.readVarInt(wrapperData, 0);
            const channelName = wrapperData.toString('utf8', clBr, clBr + channelLen);
            const payloadWrapper = wrapperData.subarray(clBr + channelLen);

            // Read inner payload length
            const { value: payloadLen, bytesRead: plBr } = this.readVarInt(payloadWrapper, 0);
            const payload = payloadWrapper.subarray(plBr, plBr + payloadLen);

            if (channelName === this.innerChannel) {
                this.handleFmlHandshake(packet.messageId, payload);
            } else {
                this.sendResponse(packet.messageId, channelName, Buffer.alloc(0));
            }
        } catch (e) {
            this.client.write('login_plugin_response', {
                messageId: packet.messageId,
                successful: false
            });
        }
    }

    handleFmlHandshake(messageId, payload) {
        const disc = payload[0];
        console.log(`[ForgeHandshake] Received discriminator ${disc}`);

        if (disc === 5) {
            // S2CModData - "noResponse()" in Forge source
            console.log('[ForgeHandshake] Received S2CModData. Skipping response.');
            return; 
        } else if (disc === 1) {
            // S2CModList
            const reply = this.buildModListReply(payload);
            this.sendResponse(messageId, this.innerChannel, reply);
        } else if (disc === 3 || disc === 4) {
            // S2CRegistry or S2CConfigData
            this.sendResponse(messageId, this.innerChannel, Buffer.from([99])); // C2SAcknowledge
            if (disc === 3) {
                this.registrySyncBuffer.push(payload);
            }
        } else if (disc === 0) {
            // ServerHello
            this.sendResponse(messageId, this.innerChannel, Buffer.from([1, 3]));
        } else {
            // Default Ack
            this.sendResponse(messageId, this.innerChannel, Buffer.from([99]));
        }
    }

    buildModListReply(serverModListPayload) {
        // Discriminator 1: S2CModList
        // Structure: Disc(1), Mods(List), Channels(Map), Registries(List), DataPackRegistries(List)
        // Reply: Disc 2: C2SModListReply
        // Structure: Disc(2), Mods(List), Channels(Map), Registries(Map)

        let offset = 1;
        const { value: mods, newOffset: o1 } = this.readList(serverModListPayload, offset, (b, o) => this.readUtf(b, o));
        offset = o1;
        const { value: channels, newOffset: o2 } = this.readMap(serverModListPayload, offset, (b, o) => this.readUtf(b, o), (b, o) => this.readUtf(b, o));
        offset = o2;

        const parts = [Buffer.from([2])];
        parts.push(this.writeList(mods, (v) => this.writeUtf(v)));
        
        // Convert map back to list of pairs for my helper
        const channelPairs = Array.from(channels.entries());
        parts.push(this.writeList(channelPairs, (v) => Buffer.concat([this.writeUtf(v[0]), this.writeUtf(v[1])])));
        
        parts.push(this.writeVarIntBuf(0)); // Registries map size 0

        return Buffer.concat(parts);
    }

    sendResponse(messageId, channel, payload) {
        const channelBuf = this.writeUtf(channel);
        const payloadLenBuf = this.writeVarIntBuf(payload.length);
        const data = Buffer.concat([channelBuf, payloadLenBuf, payload]);

        this.client.write('login_plugin_response', {
            messageId: messageId,
            successful: true,
            data: data
        });
    }

    // --- Utilities ---

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

    readUtf(buffer, offset) {
        const { value: len, bytesRead } = this.readVarInt(buffer, offset);
        const str = buffer.toString('utf8', offset + bytesRead, offset + bytesRead + len);
        return { value: str, newOffset: offset + bytesRead + len };
    }

    writeUtf(str) {
        const strBuf = Buffer.from(str, 'utf8');
        return Buffer.concat([this.writeVarIntBuf(strBuf.length), strBuf]);
    }

    readList(buffer, offset, elementReader) {
        const { value: len, bytesRead } = this.readVarInt(buffer, offset);
        offset += bytesRead;
        const list = [];
        for (let i = 0; i < len; i++) {
            const { value, newOffset } = elementReader(buffer, offset);
            list.push(value);
            offset = newOffset;
        }
        return { value: list, newOffset: offset };
    }

    writeList(list, elementWriter) {
        const bufs = [this.writeVarIntBuf(list.length)];
        for (const el of list) {
            bufs.push(elementWriter(el));
        }
        return Buffer.concat(bufs);
    }

    readMap(buffer, offset, keyReader, valueReader) {
        const { value: len, bytesRead } = this.readVarInt(buffer, offset);
        offset += bytesRead;
        const map = new Map();
        for (let i = 0; i < len; i++) {
            const { value: key, newOffset: no1 } = keyReader(buffer, offset);
            const { value: val, newOffset: no2 } = valueReader(buffer, no1);
            map.set(key, val);
            offset = no2;
        }
        return { value: map, newOffset: offset };
    }
}

module.exports = ForgeHandshakeStateMachine;
