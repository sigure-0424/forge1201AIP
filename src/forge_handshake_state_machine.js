const { EventEmitter } = require('events');

class ForgeHandshakeStateMachine extends EventEmitter {
    constructor(client) {
        super();
        this.client = client;
        this.registrySyncBuffer = [];
        this.innerChannel = 'fml:handshake';
        this.wrapperChannel = 'fml:loginwrapper';
        this.completed = false;

        const packetListener = (data, meta) => {
            if (meta.name === 'login_plugin_request') {
                // Preempt default listener to prevent double-responding with empty payloads
                const listeners = this.client.listeners('login_plugin_request');
                if (listeners.length > 0) {
                    this.client.removeAllListeners('login_plugin_request');
                }

                console.log(`[ForgeHandshake] Request for channel: ${data.channel} (ID: ${data.messageId})`);
                
                if (data.channel === this.wrapperChannel) {
                    this.handleLoginWrapper(data);
                } else if (data.channel === this.innerChannel) {
                    this.handleFmlHandshake(data.messageId, data.data, this.innerChannel);
                } else {
                    console.log(`[ForgeHandshake] Unknown channel: ${data.channel}. Sending empty response.`);
                    this.client.write('login_plugin_response', {
                        messageId: data.messageId,
                        successful: true,
                        data: null
                    });
                }
            }
        };

        this.client.on('packet', packetListener);

        this.client.once('success', () => {
            if (!this.completed) {
                console.log('[ForgeHandshake] Login Success. Handshake complete.');
                this.completed = true;
                this.emit('handshake_complete', [...this.registrySyncBuffer]);
            }
            // Keep listener active until spawn to catch late sync packets
        });
        
        this.client.once('spawn', () => {
            setTimeout(() => {
                this.client.removeListener('packet', packetListener);
                console.log('[ForgeHandshake] Handshake listener detached.');
            }, 5000);
        });
    }

    handleLoginWrapper(packet) {
        const wrapperData = packet.data;
        if (!wrapperData || wrapperData.length === 0) {
            this.sendAck(packet.messageId, this.wrapperChannel);
            return;
        }

        try {
            const { value: channelLen, bytesRead: clBr } = this.readVarInt(wrapperData, 0);
            const channelName = wrapperData.toString('utf8', clBr, clBr + channelLen);
            const payloadWrapper = wrapperData.subarray(clBr + channelLen);
            const { value: payloadLen, bytesRead: plBr } = this.readVarInt(payloadWrapper, 0);
            const payload = payloadWrapper.subarray(plBr, plBr + payloadLen);

            console.log(`[ForgeHandshake] Wrapper inner channel: ${channelName}`);

            if (channelName === this.innerChannel) {
                this.handleFmlHandshake(packet.messageId, payload, this.wrapperChannel, channelName);
            } else {
                this.sendAck(packet.messageId, this.wrapperChannel, channelName);
            }
        } catch (e) {
            console.error(`[ForgeHandshake] Parse error in wrapper: ${e.message}`);
            this.sendAck(packet.messageId, this.wrapperChannel);
        }
    }

    handleFmlHandshake(messageId, payload, responseChannel, innerChannelName = null) {
        if (!payload || payload.length === 0) {
            this.sendAck(messageId, responseChannel, innerChannelName);
            return;
        }

        const disc = payload[0];
        console.log(`[ForgeHandshake] Disc ${disc} on ${responseChannel} (Inner: ${innerChannelName || 'none'})`);

        if (disc === 0) {
            // Disc 0: ServerHello — reply with ClientHello (disc 1) + FML version byte (3)
            this.sendResponse(messageId, responseChannel, innerChannelName || this.innerChannel, Buffer.from([1, 3]));
        } else if (disc === 1) {
            // Disc 1: S2CModList — reply with C2SModListReply (disc 2)
            const reply = this.buildModListReply(payload);
            this.sendResponse(messageId, responseChannel, innerChannelName || this.innerChannel, reply);
        } else if (disc === 3 || disc === 4 || disc === 6) {
            // Disc 3: S2CRegistry (registry data) — buffer and ACK
            // Disc 4: S2CConfigData (config sync) — ACK
            // Disc 6: S2CChannelMismatchData (channel mismatch) — ACK
            this.sendAck(messageId, responseChannel, innerChannelName || this.innerChannel);
            if (disc === 3) this.registrySyncBuffer.push(payload);
        } else if (disc === 5) {
            // Disc 5: S2CModData - Forge Spec says 'noResponse()'
            console.log('[ForgeHandshake] Skipping response for Disc 5.');
        } else {
            // Unknown discriminator — ACK to keep handshake progressing
            console.log(`[ForgeHandshake] Unknown disc ${disc} — sending ACK.`);
            this.sendAck(messageId, responseChannel, innerChannelName || this.innerChannel);
        }
    }

    sendAck(messageId, channel, innerChannel = null) {
        this.sendResponse(messageId, channel, innerChannel || this.innerChannel, Buffer.from([99]));
    }

    sendResponse(messageId, channel, innerChannel, payload) {
        let data;
        if (channel === this.wrapperChannel) {
            const channelBuf = this.writeUtf(innerChannel);
            const payloadLenBuf = this.writeVarIntBuf(payload.length);
            data = Buffer.concat([channelBuf, payloadLenBuf, payload]);
        } else {
            data = payload;
        }

        this.client.write('login_plugin_response', {
            messageId: messageId,
            successful: true,
            data: data
        });
    }

    buildModListReply(serverModListPayload) {
        let offset = 1;
        const { value: mods, newOffset: o1 } = this.readList(serverModListPayload, offset, (b, o) => this.readUtf(b, o));
        offset = o1;
        const { value: channels, newOffset: o2 } = this.readMap(serverModListPayload, offset, (b, o) => this.readUtf(b, o), (b, o) => this.readUtf(b, o));
        offset = o2;

        const parts = [Buffer.from([2])];
        parts.push(this.writeList(mods, (v) => this.writeUtf(v)));
        const channelPairs = Array.from(channels.entries());
        parts.push(this.writeList(channelPairs, (v) => Buffer.concat([this.writeUtf(v[0]), this.writeUtf(v[1])])));
        parts.push(this.writeVarIntBuf(0));
        return Buffer.concat(parts);
    }

    readVarInt(buffer, offset) {
        let numRead = 0, result = 0, read;
        do {
            if (offset + numRead >= buffer.length) throw new Error('VarInt overflow');
            read = buffer.readUInt8(offset + numRead);
            result |= ((read & 0x7F) << (7 * numRead++));
        } while ((read & 0x80) !== 0);
        return { value: result, bytesRead: numRead };
    }

    writeVarIntBuf(value) {
        const bytes = [];
        do {
            let temp = (value & 0x7F);
            value >>>= 7;
            if (value !== 0) temp |= 0x80;
            bytes.push(temp);
        } while (value !== 0);
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
        for (const el of list) bufs.push(elementWriter(el));
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
